import { decodePointer, PointerRecord, requireS3Backend } from '../pointer/codec';
import { StorageBackend } from '../storage/backend';
import { OBJECT_METADATA_KEYS } from '../manifest/manifest';
import { sha256Hex, sha256Base64 } from '../hash/sha256';
import { Verifier, checksumVerifier, VerifyOutcome } from '../offload/pipeline';
import {
	withCheckoutMarkers,
	clearCheckoutMarkers,
	encodeCheckedIn,
	readCheckout,
	readCheckoutBase,
	workingCopyPath,
} from './checkout-state';
import { evaluateLock, LockState } from './lock-manager';
import { planCheckin } from './checkin';

// The checkout/check-in orchestration (spec section 4a). It composes the proven
// pieces - the S3 client, the content hash, the pointer codec, the verify ladder,
// the lock evaluation, and the additive check-in plan - into the bounded cycle:
//
//   check out: evaluate the advisory lock -> GET the object -> verify the bytes
//     against the recorded hash (never open drifted bytes) -> write the editable
//     working copy to the sync-excluded .linked-attachments/checkout/<sha>/ ->
//     mark the pointer checked-out (the visible lineage anchor stays in place) ->
//     open it in the OS default app.
//   check in:  re-hash the working copy -> unchanged = no-op -> else an ADDITIVE
//     PUT to a NEW key, verified before the pointer advances (never a replace);
//     a cloud version that advanced under us is a conflict (LWW + a visible
//     .conflict copy of the superseded version, never a merge) -> release + remove
//     the working copy.
//   discard:   release the lock and remove the working copy, no upload.
//
// All side effects are injected so the whole cycle is tier-0 testable. The native
// open and the real vault adapter are wired in the service (la-p6-33).

export interface CheckoutDeps {
	backend: StorageBackend;
	vaultPrefix: string;
	readPointer: (pointerPath: string) => Promise<string>;
	writePointer: (pointerPath: string, text: string) => Promise<void>;
	writeWorkingCopy: (path: string, bytes: Uint8Array) => Promise<void>;
	readWorkingCopy: (path: string) => Promise<Uint8Array>;
	removeWorkingCopy: (path: string) => Promise<void>;
	workingCopyExists: (path: string) => Promise<boolean>;
	openInDefaultApp: (path: string) => Promise<void>;
	writeConflictCopy: (path: string, bytes: Uint8Array) => Promise<void>;
	host: () => string;
	now: () => string;
	verify?: Verifier;
	staleAfterMs?: number;
}

export interface CheckoutResult {
	ok: boolean;
	workingCopyPath: string | null;
	lockState: LockState | null;
	error: string | null;
}

export interface CheckinResult {
	ok: boolean;
	kind: 'no-op' | 'version' | 'conflict' | null;
	record: PointerRecord | null;
	conflictPath: string | null;
	error: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class CheckoutManager {
	constructor(private readonly deps: CheckoutDeps) {}

	async checkout(pointerPath: string, opts: { force?: boolean } = {}): Promise<CheckoutResult> {
		const text = await this.deps.readPointer(pointerPath);
		const decoded = decodePointer(text);
		const record = decoded.record;

		if (record.hash === null) {
			return fail('this pointer has no recorded content hash; it cannot be checked out safely');
		}

		// Advisory cross-device lock: refuse (read-only default) when another device
		// holds it, unless the caller forces (a stale lock or a deliberate override).
		const verdict = evaluateLock({
			checkout: readCheckout(decoded),
			thisHost: this.deps.host(),
			nowMs: Date.parse(this.deps.now()),
			staleAfterMs: this.deps.staleAfterMs ?? DAY_MS,
		});
		if ((verdict.state === 'held-by-other' || verdict.state === 'stale') && opts.force !== true) {
			return { ok: false, workingCopyPath: null, lockState: verdict.state, error: verdict.message };
		}

		// GET the object and confirm its bytes match the recorded identity before we
		// open it (never hand the user drifted/overwritten bytes).
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await (await this.deps.backend.get(requireS3Backend(record).key)).arrayBuffer());
		} catch (error) {
			return fail(`could not download the object: ${describe(error)}`);
		}
		if ((await sha256Hex(bytes)) !== record.hash) {
			return fail('the downloaded bytes do not match the recorded hash; not opening (possible drift)');
		}

		const wcPath = workingCopyPath(record.hash, record.originalName);
		await this.deps.writeWorkingCopy(wcPath, bytes);
		await this.deps.writePointer(
			pointerPath,
			withCheckoutMarkers(text, { host: this.deps.host(), at: this.deps.now(), baseHash: record.hash }),
		);
		await this.deps.openInDefaultApp(wcPath);
		return { ok: true, workingCopyPath: wcPath, lockState: 'held-by-me', error: null };
	}

	async checkin(pointerPath: string): Promise<CheckinResult> {
		const text = await this.deps.readPointer(pointerPath);
		const decoded = decodePointer(text);
		const record = decoded.record;
		const baseHash = readCheckoutBase(decoded) ?? record.hash;
		if (baseHash === null) {
			return failCheckin('this pointer is not checked out');
		}
		const wcPath = workingCopyPath(baseHash, record.originalName);
		if (!(await this.deps.workingCopyExists(wcPath))) {
			return failCheckin('no working copy was found for this pointer on this device');
		}

		const working = await this.deps.readWorkingCopy(wcPath);
		const workingHash = await sha256Hex(working);
		const plan = planCheckin({
			record,
			workingHash,
			workingSize: working.length,
			checkoutBaseHash: baseHash,
			vaultPrefix: this.deps.vaultPrefix,
			now: this.deps.now,
		});

		if (plan.kind === 'no-op') {
			// Nothing to upload: just release and discard the stale working copy.
			await this.deps.writePointer(pointerPath, clearCheckoutMarkers(text));
			await this.deps.removeWorkingCopy(wcPath);
			return { ok: true, kind: 'no-op', record, conflictPath: null, error: null };
		}

		// On a conflict, preserve the superseded cloud version as a visible .conflict
		// copy first (LWW + detect-and-preserve-both, never a merge - section 4a).
		let conflictPath: string | null = null;
		if (plan.kind === 'conflict') {
			conflictPath = `${parentDir(pointerPath)}${plan.conflictName}`;
			try {
				const superseded = new Uint8Array(await (await this.deps.backend.get(plan.conflictSourceKey)).arrayBuffer());
				await this.deps.writeConflictCopy(conflictPath, superseded);
			} catch (error) {
				// If the superseded version cannot be fetched, still preserve the user's
				// own edited bytes under the conflict name rather than lose the warning.
				await this.deps.writeConflictCopy(conflictPath, working);
				void error;
			}
		}

		// Additive PUT to the new key, verified BEFORE the pointer advances. A failed
		// verify keeps the working copy and the checkout markers (the edits are safe).
		const checksumBase64 = await sha256Base64(working);
		try {
			await this.deps.backend.put(requireS3Backend(plan.record).key, working, working.length, {
				checksumSha256: checksumBase64,
				contentType: plan.record.contentType,
				metadata: {
					[OBJECT_METADATA_KEYS.sha256]: plan.record.hash ?? '',
					[OBJECT_METADATA_KEYS.id]: plan.record.id,
					[OBJECT_METADATA_KEYS.originalPath]: plan.record.originalPath,
					[OBJECT_METADATA_KEYS.originalName]: plan.record.originalName,
					[OBJECT_METADATA_KEYS.byteSize]: String(working.length),
					[OBJECT_METADATA_KEYS.contentType]: plan.record.contentType,
				},
			});
		} catch (error) {
			return failCheckin(`upload failed: ${describe(error)}`);
		}

		const verify = this.deps.verify ?? checksumVerifier;
		let outcome: VerifyOutcome;
		try {
			outcome = await verify(this.deps.backend, requireS3Backend(plan.record).key, { hash: plan.record.hash ?? '', checksumBase64, size: working.length });
		} catch (error) {
			return failCheckin(`verify failed: ${describe(error)}`);
		}
		if (!outcome.ok) {
			return failCheckin(outcome.reason ?? 'the uploaded version could not be verified');
		}

		const committed: PointerRecord = { ...plan.record, verificationTier: outcome.tier, remoteChecksum: outcome.remoteChecksum };
		await this.deps.writePointer(pointerPath, encodeCheckedIn(text, committed));
		await this.deps.removeWorkingCopy(wcPath);
		return { ok: true, kind: plan.kind, record: committed, conflictPath, error: null };
	}

	async discard(pointerPath: string): Promise<{ ok: boolean; error: string | null }> {
		const text = await this.deps.readPointer(pointerPath);
		const decoded = decodePointer(text);
		const baseHash = readCheckoutBase(decoded) ?? decoded.record.hash;
		await this.deps.writePointer(pointerPath, clearCheckoutMarkers(text));
		if (baseHash !== null) {
			const wcPath = workingCopyPath(baseHash, decoded.record.originalName);
			if (await this.deps.workingCopyExists(wcPath)) {
				await this.deps.removeWorkingCopy(wcPath);
			}
		}
		return { ok: true, error: null };
	}
}

// --- internals --------------------------------------------------------------

function fail(error: string): CheckoutResult {
	return { ok: false, workingCopyPath: null, lockState: null, error };
}

function failCheckin(error: string): CheckinResult {
	return { ok: false, kind: null, record: null, conflictPath: null, error };
}

function parentDir(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? path.slice(0, slash + 1) : '';
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
