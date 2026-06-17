import { encodePointer, PointerRecord, VerificationTier } from '../pointer/codec';
import { sha256Base64 } from '../hash/sha256';
import { OBJECT_METADATA_KEYS } from '../manifest/manifest';
import { StorageBackend } from '../storage/backend';
import { planOffload } from './plan';

// The offload pipeline (spec section 4 / 7.7, with the section 10 safety
// invariants). The O6 order is a data-loss firewall:
//
//   stage pointer -> upload -> verify -> commit pointer -> remove local original
//
// The local original is removed ONLY after a passing verify and a committed
// pointer. Every failure path leaves the original in place (F1 verify-before-
// delete; "no HEAD -> no delete" on dead creds; O6 rollback on a failed upload).
// A pre-existing object at the key is never trusted because the key is present -
// the pipeline always uploads and verifies, so a dropped-PUT stub is overwritten
// and re-verified (re-verify-on-resume).
//
// Vault side effects (writePointer, trashOriginal) and id/timestamp generation
// are injected so the whole sequence is tier-0 testable against MemoryBackend.
// The verify ladder and the delete-gate minimum tier are seams (la-p2-08); this
// story ships the default checksummed-PUT verifier and a content/md5 remove gate.

export type OffloadStage = 'staged' | 'uploaded' | 'verified' | 'committed' | 'removed';

export interface OffloadFile {
	path: string;
	bytes: Uint8Array;
	contentType: string;
}

export interface VerifyExpectation {
	hash: string;
	checksumBase64: string;
	size: number;
}

export interface VerifyOutcome {
	ok: boolean;
	tier: VerificationTier;
	remoteChecksum: string | null;
	reason: string | null;
}

export type Verifier = (backend: StorageBackend, key: string, expectation: VerifyExpectation) => Promise<VerifyOutcome>;

export interface OffloadDeps {
	backend: StorageBackend;
	bucket: string;
	vaultPrefix: string;
	writePointer: (pointerPath: string, content: string) => Promise<void>;
	trashOriginal: (path: string) => Promise<void>;
	newId: () => string;
	now: () => string;
	verify?: Verifier;
	canRemoveOriginal?: (tier: VerificationTier) => boolean;
}

export interface OffloadResult {
	ok: boolean;
	reachedStage: OffloadStage;
	removed: boolean;
	record: PointerRecord | null;
	pointerPath: string | null;
	error: string | null;
}

// The default verify: a checksummed PUT means the server validated the received
// bytes against the sha256, so a confirming HEAD (size + checksum match) is
// content-verification with no re-download (spec section 10 F1 rung 1, confirmed
// on R2). The richer ladder (md5 fallback, GET+rehash, refuse floor) is la-p2-08.
export const checksumVerifier: Verifier = async (backend, key, expectation) => {
	const head = await backend.head(key);
	if (head.size === expectation.size && head.checksumSha256 === expectation.checksumBase64) {
		return { ok: true, tier: 'content', remoteChecksum: head.checksumSha256 ?? null, reason: null };
	}
	return {
		ok: false,
		tier: 'existence',
		remoteChecksum: head.checksumSha256 ?? null,
		reason: `verify mismatch: size ${head.size} vs ${expectation.size}, checksum present=${String(head.checksumSha256 !== undefined)}`,
	};
};

// Only content- or md5-verified objects unlock removal of the local original;
// asserted/existence are not enough to hard-delete (spec section 10 F1 default).
export function defaultCanRemoveOriginal(tier: VerificationTier): boolean {
	return tier === 'content' || tier === 'md5';
}

export async function offloadFile(file: OffloadFile, deps: OffloadDeps): Promise<OffloadResult> {
	const verify = deps.verify ?? checksumVerifier;
	const canRemove = deps.canRemoveOriginal ?? defaultCanRemoveOriginal;

	// The preview module is the single source of the key/pointerPath/hash
	// derivation, so the committed pointer matches what a dry-run showed.
	const plan = await planOffload(file, { vaultPrefix: deps.vaultPrefix, bucket: deps.bucket });
	const { hash, key, pointerPath } = plan;
	const checksumBase64 = await sha256Base64(file.bytes);

	const record: PointerRecord = {
		laVersion: 1,
		id: deps.newId(),
		hash,
		bucket: deps.bucket,
		key,
		keyKind: plan.keyKind,
		originalName: plan.originalName,
		originalExt: plan.originalExt,
		originalPath: file.path,
		byteSize: plan.byteSize,
		contentType: file.contentType,
		copyState: 'offloaded',
		verificationTier: 'asserted',
		remoteChecksum: null,
		checksumAlgo: 'sha256',
		partSize: null,
		partCount: null,
		offloadedAt: deps.now(),
		sourceVersion: null,
		supersedes: null,
	};

	// Upload. A failure here is the cleanest rollback: no pointer, original intact.
	try {
		await deps.backend.put(key, file.bytes, file.bytes.length, {
			checksumSha256: checksumBase64,
			contentType: file.contentType,
			metadata: {
				[OBJECT_METADATA_KEYS.sha256]: hash,
				[OBJECT_METADATA_KEYS.id]: record.id,
				[OBJECT_METADATA_KEYS.originalPath]: file.path,
				[OBJECT_METADATA_KEYS.originalName]: plan.originalName,
				[OBJECT_METADATA_KEYS.byteSize]: String(file.bytes.length),
				[OBJECT_METADATA_KEYS.contentType]: file.contentType,
			},
		});
	} catch (error) {
		return failure('staged', record, pointerPath, `upload failed: ${describe(error)}`);
	}

	// Verify. A throw here is dead creds / network: we cannot prove the bytes, so
	// the original is kept untouched (no HEAD -> no delete).
	let outcome: VerifyOutcome;
	try {
		outcome = await verify(deps.backend, key, { hash, checksumBase64, size: file.bytes.length });
	} catch (error) {
		return failure('uploaded', record, pointerPath, `verify failed: ${describe(error)}`);
	}
	if (!outcome.ok) {
		return failure('uploaded', record, pointerPath, outcome.reason ?? 'verification failed');
	}
	record.verificationTier = outcome.tier;
	record.remoteChecksum = outcome.remoteChecksum;

	// Commit the pointer. A failure here keeps the original: the bytes are safely
	// in the bucket, so no data is lost; the space is simply not reclaimed yet.
	try {
		await deps.writePointer(pointerPath, encodePointer(record, ''));
	} catch (error) {
		return failure('verified', record, pointerPath, `commit failed: ${describe(error)}`);
	}

	// Remove the local original, only if the achieved tier clears the gate.
	if (!canRemove(record.verificationTier)) {
		return { ok: true, reachedStage: 'committed', removed: false, record, pointerPath, error: null };
	}
	try {
		await deps.trashOriginal(file.path);
	} catch (error) {
		// Pointer committed + verified; the original simply remains. Non-fatal.
		return { ok: true, reachedStage: 'committed', removed: false, record, pointerPath, error: `original not trashed: ${describe(error)}` };
	}
	return { ok: true, reachedStage: 'removed', removed: true, record, pointerPath, error: null };
}

// --- internals --------------------------------------------------------------

function failure(reachedStage: OffloadStage, record: PointerRecord, pointerPath: string, error: string): OffloadResult {
	return { ok: false, reachedStage, removed: false, record, pointerPath, error };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
