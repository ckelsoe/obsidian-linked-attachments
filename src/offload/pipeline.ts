import { BackendRef, encodePointer, LA_VERSION, PointerRecord, VerificationTier } from '../pointer/codec';
import { sha256Base64 } from '../hash/sha256';
import { OBJECT_METADATA_KEYS } from '../manifest/manifest';
import { StorageBackend } from '../storage/backend';
import { DedupTarget } from './dedup';
import { OffloadPlan, planOffload } from './plan';

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

// One destination an offload writes to, plus how it is recorded on the pointer.
// The same object key addresses every backend (the key layout is backend-neutral),
// so a target only needs to say how to turn that key into its BackendRef.
export interface OffloadTarget {
	backend: StorageBackend;
	toRef: (key: string) => BackendRef;
}

export interface OffloadDeps {
	// Every backend to write to, in read-preference order (first = preferred read).
	// Paired offload writes them all as one transaction: on any partial failure the
	// already-written copies are deleted so the local original is never trashed
	// against an incomplete backend set (never a pointer with a backend that does
	// not hold the bytes - spec section 3 / 10 atomicity).
	targets: OffloadTarget[];
	// Labels the plan/preview only; each target's toRef carries its own address.
	bucket: string;
	vaultPrefix: string;
	writePointer: (pointerPath: string, content: string) => Promise<void>;
	trashOriginal: (path: string) => Promise<void>;
	newId: () => string;
	now: () => string;
	verify?: Verifier;
	canRemoveOriginal?: (tier: VerificationTier) => boolean;
	// Content-dedup pre-check (spec section 10): given the file's sha256, return an
	// existing object with those exact bytes, or null. When it returns a target, the
	// pipeline links to that object instead of uploading a second one - but still
	// verifies the existing object holds the bytes before trashing the local original
	// (a stale index never authorizes a delete). Absent => always upload (unchanged).
	findExistingByHash?: (hash: string) => Promise<DedupTarget | null>;
}

export interface OffloadResult {
	ok: boolean;
	reachedStage: OffloadStage;
	removed: boolean;
	record: PointerRecord | null;
	pointerPath: string | null;
	error: string | null;
	// True when this offload linked to an object already in storage (no upload).
	deduped: boolean;
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

	// Content-dedup pre-check: if these exact bytes are already in storage, link to
	// the existing object instead of uploading a second one. A null result (no match,
	// drift, or unconfirmable existing object) falls through to a normal upload, so
	// the file is always safely offloaded either way.
	if (deps.findExistingByHash !== undefined) {
		const existing = await deps.findExistingByHash(hash);
		if (existing !== null) {
			const linked = await tryDedup(file, plan, existing, checksumBase64, deps, verify, canRemove);
			if (linked !== null) {
				return linked;
			}
		}
	}

	const record: PointerRecord = {
		laVersion: LA_VERSION,
		id: deps.newId(),
		hash,
		backends: deps.targets.map((target) => target.toRef(key)),
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

	const metadata = {
		[OBJECT_METADATA_KEYS.sha256]: hash,
		[OBJECT_METADATA_KEYS.id]: record.id,
		[OBJECT_METADATA_KEYS.originalPath]: file.path,
		[OBJECT_METADATA_KEYS.originalName]: plan.originalName,
		[OBJECT_METADATA_KEYS.byteSize]: String(file.bytes.length),
		[OBJECT_METADATA_KEYS.contentType]: file.contentType,
	};

	// Write to every target and verify each, as one transaction. A failure at any
	// target rolls back the copies already written (delete-best-effort) and keeps
	// the local original, so the user is never left with a pointer whose backend set
	// is incomplete. The recorded tier is the WEAKEST any target achieved, so the
	// delete gate is only cleared when every copy is genuinely verified.
	const written: OffloadTarget[] = [];
	let worstTier: VerificationTier = 'content';
	let remoteChecksum: string | null = null;
	for (const target of deps.targets) {
		try {
			await target.backend.put(key, file.bytes, file.bytes.length, { checksumSha256: checksumBase64, contentType: file.contentType, metadata });
		} catch (error) {
			await rollback(written, key);
			return failure('staged', record, pointerPath, `upload failed: ${describe(error)}`);
		}
		let outcome: VerifyOutcome;
		try {
			outcome = await verify(target.backend, key, { hash, checksumBase64, size: file.bytes.length });
		} catch (error) {
			// This target's PUT landed but could not be verified; roll it back too.
			await rollback([...written, target], key);
			return failure('uploaded', record, pointerPath, `verify failed: ${describe(error)}`);
		}
		if (!outcome.ok) {
			await rollback([...written, target], key);
			return failure('uploaded', record, pointerPath, outcome.reason ?? 'verification failed');
		}
		written.push(target);
		worstTier = weakerTier(worstTier, outcome.tier);
		remoteChecksum = remoteChecksum ?? outcome.remoteChecksum;
	}
	record.verificationTier = worstTier;
	record.remoteChecksum = remoteChecksum;

	// Commit the pointer. A failure here keeps the original: the bytes are safely
	// in the bucket, so no data is lost; the space is simply not reclaimed yet.
	try {
		await deps.writePointer(pointerPath, encodePointer(record, ''));
	} catch (error) {
		return failure('verified', record, pointerPath, `commit failed: ${describe(error)}`);
	}

	// Remove the local original, only if the achieved tier clears the gate.
	if (!canRemove(record.verificationTier)) {
		return { ok: true, reachedStage: 'committed', removed: false, record, pointerPath, error: null, deduped: false };
	}
	try {
		await deps.trashOriginal(file.path);
	} catch (error) {
		// Pointer committed + verified; the original simply remains. Non-fatal.
		return { ok: true, reachedStage: 'committed', removed: false, record, pointerPath, error: `original not trashed: ${describe(error)}`, deduped: false };
	}
	return { ok: true, reachedStage: 'removed', removed: true, record, pointerPath, error: null, deduped: false };
}

// --- internals --------------------------------------------------------------

// The dedup path: link to an object already in storage instead of uploading. We
// still verify the EXISTING object holds these exact bytes (F1: a stale index
// never authorizes a delete), then commit a pointer referencing it and trash the
// local original if the gate clears. Returns null when the existing object cannot
// be confirmed (verify throws or mismatches), so the caller uploads a fresh copy.
async function tryDedup(
	file: OffloadFile,
	plan: OffloadPlan,
	existing: DedupTarget,
	checksumBase64: string,
	deps: OffloadDeps,
	verify: Verifier,
	canRemove: (tier: VerificationTier) => boolean,
): Promise<OffloadResult | null> {
	// Dedup targets an existing S3 object, so it only runs when S3 is the offload
	// destination (the service supplies findExistingByHash for S3-only mode alone);
	// targets[0] is that S3 backend.
	const s3Backend = deps.targets[0]?.backend;
	if (s3Backend === undefined) {
		return null;
	}
	let outcome: VerifyOutcome;
	try {
		outcome = await verify(s3Backend, existing.key, { hash: plan.hash, checksumBase64, size: plan.byteSize });
	} catch {
		return null; // cannot reach / confirm the existing object -> upload normally
	}
	if (!outcome.ok) {
		return null; // existing object drifted or is missing -> upload a fresh copy
	}

	const record: PointerRecord = {
		laVersion: LA_VERSION,
		id: deps.newId(),
		hash: plan.hash,
		backends: [{ type: 's3', bucket: existing.bucket, key: existing.key, keyKind: existing.keyKind }],
		originalName: plan.originalName,
		originalExt: plan.originalExt,
		originalPath: file.path,
		byteSize: plan.byteSize,
		contentType: file.contentType,
		copyState: 'offloaded',
		verificationTier: outcome.tier,
		remoteChecksum: outcome.remoteChecksum,
		checksumAlgo: 'sha256',
		partSize: null,
		partCount: null,
		offloadedAt: deps.now(),
		sourceVersion: null,
		supersedes: null,
	};

	try {
		await deps.writePointer(plan.pointerPath, encodePointer(record, ''));
	} catch (error) {
		return { ok: false, reachedStage: 'verified', removed: false, record, pointerPath: plan.pointerPath, error: `commit failed: ${describe(error)}`, deduped: true };
	}
	if (!canRemove(record.verificationTier)) {
		return { ok: true, reachedStage: 'committed', removed: false, record, pointerPath: plan.pointerPath, error: null, deduped: true };
	}
	try {
		await deps.trashOriginal(file.path);
	} catch (error) {
		return { ok: true, reachedStage: 'committed', removed: false, record, pointerPath: plan.pointerPath, error: `original not trashed: ${describe(error)}`, deduped: true };
	}
	return { ok: true, reachedStage: 'removed', removed: true, record, pointerPath: plan.pointerPath, error: null, deduped: true };
}

// Best-effort rollback of the copies already written in a paired offload. A delete
// that itself fails is swallowed: the local original is kept regardless (no pointer
// was committed), so a lingering orphan copy is a cost concern, never data loss, and
// the reconcile scan surfaces it later.
async function rollback(written: OffloadTarget[], key: string): Promise<void> {
	for (const target of written) {
		try {
			await target.backend.delete(key);
		} catch {
			// Ignore; the original is untouched and the orphan is reconcilable.
		}
	}
}

const TIER_ORDER: Record<VerificationTier, number> = { asserted: 0, existence: 1, md5: 2, content: 3 };

// The weaker of two tiers, so a paired pointer records the LEAST it proved across
// all copies (the delete gate must see every copy verified, not just the strongest).
function weakerTier(a: VerificationTier, b: VerificationTier): VerificationTier {
	return TIER_ORDER[a] <= TIER_ORDER[b] ? a : b;
}

function failure(reachedStage: OffloadStage, record: PointerRecord, pointerPath: string, error: string): OffloadResult {
	return { ok: false, reachedStage, removed: false, record, pointerPath, error, deduped: false };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
