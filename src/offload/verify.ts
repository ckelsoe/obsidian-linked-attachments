import { VerificationTier } from '../pointer/codec';
import { StorageBackend } from '../storage/backend';
import { sha256Hex } from '../hash/sha256';
import { Verifier } from './pipeline';

// F1 verify-before-delete (spec section 10 F1, the product thesis). Never
// hard-delete a local original until the bucket is confirmed to hold the same
// bytes. Two pieces, deliberately separated so a weak verify can never silently
// authorize a delete:
//
//   - verifyByLadder reports the STRONGEST tier it could actually achieve,
//     strongest-first:
//       1. checksummed PUT -> HEAD confirms x-amz-checksum-sha256: content, no
//          re-download (R2-confirmed default).
//       2. Content-MD5 etag match (single-part fallback): md5.
//       3. GET + rehash (the universal backstop): content.
//       4. nothing provable (object missing, HEAD/GET fail, or bytes drift):
//          existence or asserted - NOT delete-worthy.
//   - canHardDelete is the gate: the achieved tier must meet a configurable
//     minimum (default content-or-md5). asserted-delete is an explicit opt-in.
//
// verifyBeforeDelete runs the ladder immediately before deleting and calls the
// delete callback ONLY when the gate clears. It never falls through to a weaker
// tier and deletes anyway.

export interface LadderExpectation {
	hash: string; // local sha256 hex (identity / GET+rehash target)
	checksumBase64: string; // local sha256 base64 (x-amz-checksum-sha256 form)
	size: number;
	md5Hex?: string; // local Content-MD5 hex, when the md5 rung is in play
}

export interface LadderResult {
	tier: VerificationTier;
	remoteChecksum: string | null;
	reason: string | null;
}

export interface DeleteGateConfig {
	minimumTier?: VerificationTier;
	allowAssertedDelete?: boolean;
}

export interface DeleteDecision {
	deleted: boolean;
	refused: boolean;
	achievedTier: VerificationTier;
	remoteChecksum: string | null;
	reason: string | null;
}

const TIER_RANK: Record<VerificationTier, number> = { asserted: 0, existence: 1, md5: 2, content: 3 };

export async function verifyByLadder(backend: StorageBackend, key: string, expectation: LadderExpectation): Promise<LadderResult> {
	let head;
	try {
		head = await backend.head(key);
	} catch (error) {
		// No HEAD -> nothing is proven -> asserted (the gate will refuse a delete).
		return { tier: 'asserted', remoteChecksum: null, reason: `head failed: ${describe(error)}` };
	}
	// Size is only a cheap sanity check; the server checksum and the GET+rehash are
	// the real byte proofs. Obsidian's requestUrl reports content-length as 0 on a
	// HEAD response (no body), so a 0/unknown size must NOT veto a checksum that
	// matches - it only blocks when the size is positively present and wrong.
	const sizeContradicts = head.size > 0 && head.size !== expectation.size;
	const sizeOk = !sizeContradicts;
	const remoteChecksum = head.checksumSha256 ?? null;

	// Rung 1: server checksum (cheapest content verification).
	if (backend.capabilities.upload.serverChecksum && head.checksumSha256 !== undefined) {
		if (sizeOk && head.checksumSha256 === expectation.checksumBase64) {
			return { tier: 'content', remoteChecksum, reason: null };
		}
	}

	// Rung 2: Content-MD5 etag match (single-part fallback).
	if (expectation.md5Hex !== undefined && sizeOk) {
		if (normalizeEtag(head.etag) === expectation.md5Hex.toLowerCase()) {
			return { tier: 'md5', remoteChecksum, reason: null };
		}
	}

	// Rung 3: GET + rehash, the universal backstop.
	try {
		const got = await backend.get(key);
		const bytes = new Uint8Array(await got.arrayBuffer());
		if ((await sha256Hex(bytes)) === expectation.hash) {
			return { tier: 'content', remoteChecksum, reason: null };
		}
		// The object exists but its bytes do not match: drift, not verification.
		return {
			tier: sizeOk ? 'existence' : 'asserted',
			remoteChecksum,
			reason: 'content mismatch on GET+rehash (possible external overwrite / drift)',
		};
	} catch (error) {
		// GET unavailable (egress blocked, fault): fall back to existence if the
		// object at least HEADs with the right size, else asserted.
		return {
			tier: sizeOk ? 'existence' : 'asserted',
			remoteChecksum,
			reason: `get failed: ${describe(error)}`,
		};
	}
}

export function canHardDelete(tier: VerificationTier, config: DeleteGateConfig = {}): boolean {
	const minimum: VerificationTier = config.allowAssertedDelete ? 'asserted' : config.minimumTier ?? 'md5';
	return TIER_RANK[tier] >= TIER_RANK[minimum];
}

export async function verifyBeforeDelete(
	backend: StorageBackend,
	key: string,
	expectation: LadderExpectation,
	doDelete: () => Promise<void>,
	config: DeleteGateConfig = {},
): Promise<DeleteDecision> {
	const result = await verifyByLadder(backend, key, expectation);
	if (!canHardDelete(result.tier, config)) {
		return {
			deleted: false,
			refused: true,
			achievedTier: result.tier,
			remoteChecksum: result.remoteChecksum,
			reason: result.reason ?? `refusing to delete: achieved ${result.tier}, below the configured minimum`,
		};
	}
	// The delete callback's own errors propagate to the caller; verification
	// passed, so this is the caller's I/O failure to handle, not a verify refusal.
	await doDelete();
	return { deleted: true, refused: false, achievedTier: result.tier, remoteChecksum: result.remoteChecksum, reason: null };
}

// Adapt the ladder to the offload pipeline's Verifier contract: ok is true only
// for a bytes-proven tier (content or md5).
export const ladderVerifier: Verifier = async (backend, key, expectation) => {
	const result = await verifyByLadder(backend, key, {
		hash: expectation.hash,
		checksumBase64: expectation.checksumBase64,
		size: expectation.size,
	});
	return {
		ok: result.tier === 'content' || result.tier === 'md5',
		tier: result.tier,
		remoteChecksum: result.remoteChecksum,
		reason: result.reason,
	};
};

// --- internals --------------------------------------------------------------

function normalizeEtag(etag: string): string {
	return etag.replace(/^"|"$/g, '').toLowerCase();
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
