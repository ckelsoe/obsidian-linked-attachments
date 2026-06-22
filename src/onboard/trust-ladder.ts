import { StorageBackend } from '../storage/backend';
import { sha256Base64, sha256Hex } from '../hash/sha256';

// S6 first-file round-trip trust check (development-plan section 8). Before a user
// trusts the plugin with a real file, the rehearsal exercises their actual bucket
// end to end on a throwaway object and shows the four-stage ladder:
//
//   uploaded -> verified byte-for-byte -> retrieved -> matches the original
//
// Each stage is one backend verb, so the whole thing is tier-0 testable against
// MemoryBackend; the live modal that renders it is the only part needing a real
// runtime. The rehearsal is honest: a failure stops at the exact stage and never
// reports a later stage as passed. The throwaway object is always cleaned up
// (best-effort), even when a stage fails, so a rehearsal leaves no trace.

export type TrustStageId = 'uploaded' | 'verified' | 'retrieved' | 'matched';
export type StageStatus = 'pending' | 'passed' | 'failed';

export interface TrustStage {
	id: TrustStageId;
	label: string;
	status: StageStatus;
	detail: string | null;
}

export interface TrustRehearsalDeps {
	backend: StorageBackend;
	key: string; // a throwaway key the caller generates (random, never a real file)
	payload: Uint8Array; // generated test bytes
	onStage?: (stage: TrustStage) => void; // live updates for the modal
}

export interface TrustRehearsalResult {
	ok: boolean;
	stages: TrustStage[];
	failedStage: TrustStageId | null;
	error: string | null;
}

const STAGE_LABELS: Record<TrustStageId, string> = {
	uploaded: 'Uploaded',
	verified: 'Verified byte-for-byte',
	retrieved: 'Retrieved',
	matched: 'Matches the original',
};

const STAGE_ORDER: TrustStageId[] = ['uploaded', 'verified', 'retrieved', 'matched'];

export async function runTrustRehearsal(deps: TrustRehearsalDeps): Promise<TrustRehearsalResult> {
	const stages: TrustStage[] = STAGE_ORDER.map((id) => ({ id, label: STAGE_LABELS[id], status: 'pending', detail: null }));
	const byId = (id: TrustStageId): TrustStage => stages.find((s) => s.id === id) as TrustStage;
	const settle = (id: TrustStageId, status: StageStatus, detail: string | null): void => {
		const stage = byId(id);
		stage.status = status;
		stage.detail = detail;
		deps.onStage?.(stage);
	};

	const expectedChecksum = await sha256Base64(deps.payload);
	const expectedHash = await sha256Hex(deps.payload);
	let failedStage: TrustStageId | null = null;
	let error: string | null = null;
	// Track whether an upload happened, so cleanup runs whenever an object may exist.
	let uploaded = false;

	try {
		// 1. Uploaded - a checksummed PUT; the server validates the bytes.
		await deps.backend.put(deps.key, deps.payload, deps.payload.length, {
			checksumSha256: expectedChecksum,
			contentType: 'text/plain',
		});
		uploaded = true;
		settle('uploaded', 'passed', null);

		// 2. Verified byte-for-byte - HEAD confirms size and (where the backend
		// returns one) the server-side checksum, no re-download. The GET+rehash in
		// stage four is the universal byte proof; this stage is the cheap confirm.
		const head = await deps.backend.head(deps.key);
		if (head.size > 0 && head.size !== deps.payload.length) {
			settle('verified', 'failed', `size ${head.size} != ${deps.payload.length}`);
			failedStage = 'verified';
		} else if (head.checksumSha256 !== undefined && head.checksumSha256 !== expectedChecksum) {
			settle('verified', 'failed', 'server checksum does not match');
			failedStage = 'verified';
		} else if (head.checksumSha256 !== undefined) {
			settle('verified', 'passed', 'checksum confirmed');
		} else if (head.size > 0) {
			settle('verified', 'passed', 'size confirmed');
		} else {
			// HEAD gave nothing usable (Obsidian's requestUrl omits content-length on a
			// HEAD); the byte-for-byte truth is the GET+rehash in stage four.
			settle('verified', 'passed', 'confirmed on retrieval');
		}

		// 3. Retrieved - download the object back.
		let gotBytes: Uint8Array | null = null;
		if (failedStage === null) {
			const got = await deps.backend.get(deps.key);
			gotBytes = new Uint8Array(await got.arrayBuffer());
			settle('retrieved', 'passed', null);
		}

		// 4. Matches the original - re-hash the downloaded bytes and compare.
		if (failedStage === null && gotBytes !== null) {
			const gotHash = await sha256Hex(gotBytes);
			if (gotHash === expectedHash) {
				settle('matched', 'passed', null);
			} else {
				settle('matched', 'failed', 'downloaded bytes do not match');
				failedStage = 'matched';
			}
		}
	} catch (err) {
		// The first still-pending stage is the one that threw.
		const pending = stages.find((s) => s.status === 'pending');
		failedStage = pending?.id ?? null;
		error = describe(err);
		if (pending !== undefined) {
			settle(pending.id, 'failed', error);
		}
	}

	// Cleanup is best-effort and never changes the verdict: a rehearsal must leave
	// no trace, but a failed delete (e.g. read-only creds) is not a rehearsal failure.
	if (uploaded) {
		try {
			await deps.backend.delete(deps.key);
		} catch {
			// ignore; the throwaway object simply remains
		}
	}

	const ok = failedStage === null;
	return { ok, stages, failedStage, error };
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
