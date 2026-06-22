import fc from 'fast-check';
import {
	verifyByLadder,
	canHardDelete,
	verifyBeforeDelete,
	ladderVerifier,
	LadderExpectation,
} from './verify';
import { MemoryBackend } from '../storage/memory-backend';
import { Capabilities, GetRange, StorageBackend } from '../storage/backend';
import { VerificationTier } from '../pointer/codec';
import { sha256Base64, sha256Hex } from '../hash/sha256';

// Tier 0: the verify ladder + delete gate against MemoryBackend, including a
// no-server-checksum backend to exercise the md5 and GET+rehash rungs.

function bytesOf(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

const NO_SERVER_CHECKSUM: Capabilities = {
	upload: { presign: true, range: true, serverChecksum: false, conditionalWrite: false },
	access: 'presigned-url',
};

async function expectationFor(bytes: Uint8Array, extra: Partial<LadderExpectation> = {}): Promise<LadderExpectation> {
	return {
		hash: await sha256Hex(bytes),
		checksumBase64: await sha256Base64(bytes),
		size: bytes.length,
		...extra,
	};
}

const ALL_TIERS: VerificationTier[] = ['asserted', 'existence', 'md5', 'content'];
const RANK: Record<VerificationTier, number> = { asserted: 0, existence: 1, md5: 2, content: 3 };

describe('verify ladder acceptance (la-p2-08)', () => {
	// AC1 :: a checksummed-PUT object verifies to content with no re-download
	// (rung 1; spec section 10 F1).
	it('test_checksum_rung_content', async () => {
		const backend = new MemoryBackend();
		const bytes = bytesOf('verify me');
		await backend.put('k', bytes, bytes.length, { checksumSha256: await sha256Base64(bytes) });
		const result = await verifyByLadder(backend, 'k', await expectationFor(bytes));
		expect(result.tier).toBe('content');
	});

	// AC1b :: Obsidian's requestUrl reports size 0 on a HEAD response (no body). A
	// matching server checksum must STILL verify to content with no re-download - the
	// size is only a sanity check and a 0/unknown size must not veto the checksum.
	it('test_checksum_rung_content_when_head_size_unknown', async () => {
		const inner = new MemoryBackend();
		const bytes = bytesOf('verify me even with a sizeless head');
		await inner.put('k', bytes, bytes.length, { checksumSha256: await sha256Base64(bytes) });
		const zeroHeadSize: StorageBackend = {
			capabilities: inner.capabilities,
			put: (k, b, s, o) => inner.put(k, b, s, o),
			head: async (k) => ({ ...(await inner.head(k)), size: 0 }),
			get: (k, range?: GetRange) => inner.get(k, range),
			delete: (k) => inner.delete(k),
			list: (p, o) => inner.list(p, o),
			displayKey: (k) => inner.displayKey(k),
		};
		const result = await verifyByLadder(zeroHeadSize, 'k', await expectationFor(bytes));
		expect(result.tier).toBe('content');
	});

	// AC2 :: with no server checksum, a matching Content-MD5 etag verifies to md5
	// (rung 2). The md5 is a client value compared to the object etag.
	it('test_md5_rung', async () => {
		const backend = new MemoryBackend({ capabilities: NO_SERVER_CHECKSUM });
		const bytes = bytesOf('budget');
		await backend.seedObject('k', bytes, { etag: '"D41D8CD98F00B204E9800998ECF8427E"' });
		const result = await verifyByLadder(backend, 'k', await expectationFor(bytes, { md5Hex: 'd41d8cd98f00b204e9800998ecf8427e' }));
		expect(result.tier).toBe('md5');
	});

	// AC3 :: with no server checksum and no md5, GET+rehash proves the bytes and
	// verifies to content (rung 3, the universal backstop).
	it('test_get_rehash_fallback', async () => {
		const backend = new MemoryBackend({ capabilities: NO_SERVER_CHECKSUM });
		const bytes = bytesOf('the whole document body');
		await backend.seedObject('k', bytes, { etag: '"opaque-not-md5"' });
		const result = await verifyByLadder(backend, 'k', await expectationFor(bytes));
		expect(result.tier).toBe('content');
	});

	// AC4 :: a missing object cannot be verified; the ladder reports asserted and
	// the delete is refused (the refuse-to-hard-delete floor; spec section 10).
	it('test_refuse_floor_missing_object', async () => {
		const backend = new MemoryBackend();
		let deleteCalls = 0;
		const decision = await verifyBeforeDelete(backend, 'missing', await expectationFor(bytesOf('x')), () => {
			deleteCalls++;
			return Promise.resolve();
		});
		expect(decision.deleted).toBe(false);
		expect(decision.refused).toBe(true);
		expect(deleteCalls).toBe(0);
	});

	// AC5 :: the delete gate enforces a configurable minimum tier; asserted-delete
	// is an explicit opt-in. (spec section 10 F1)
	it('test_delete_gate_min_tier', () => {
		expect(canHardDelete('content')).toBe(true);
		expect(canHardDelete('md5')).toBe(true);
		expect(canHardDelete('existence')).toBe(false);
		expect(canHardDelete('asserted')).toBe(false);
		expect(canHardDelete('asserted', { allowAssertedDelete: true })).toBe(true);
		expect(canHardDelete('content', { minimumTier: 'content' })).toBe(true);
		expect(canHardDelete('md5', { minimumTier: 'content' })).toBe(false);
	});

	// AC6 :: verifyBeforeDelete deletes exactly once when the achieved tier clears
	// the gate.
	it('test_verify_before_delete_deletes_on_content', async () => {
		const backend = new MemoryBackend();
		const bytes = bytesOf('verified bytes');
		await backend.put('k', bytes, bytes.length, { checksumSha256: await sha256Base64(bytes) });
		let deleteCalls = 0;
		const decision = await verifyBeforeDelete(backend, 'k', await expectationFor(bytes), () => {
			deleteCalls++;
			return Promise.resolve();
		});
		expect(decision.deleted).toBe(true);
		expect(decision.achievedTier).toBe('content');
		expect(deleteCalls).toBe(1);
	});

	// AC7 :: when only existence can be established (no checksum, no md5, GET
	// disabled by a fault) the delete is refused at the default minimum.
	it('test_verify_before_delete_refuses_below_min', async () => {
		const backend = new MemoryBackend({ capabilities: NO_SERVER_CHECKSUM });
		const bytes = bytesOf('present but unprovable');
		await backend.seedObject('k', bytes, { etag: '"opaque"' });
		backend.faults.get = () => {
			throw new Error('egress blocked');
		};
		let deleteCalls = 0;
		const decision = await verifyBeforeDelete(backend, 'k', await expectationFor(bytes), () => {
			deleteCalls++;
			return Promise.resolve();
		});
		expect(decision.achievedTier).toBe('existence');
		expect(decision.refused).toBe(true);
		expect(deleteCalls).toBe(0);
	});

	// AC8 :: drift (the object holds different bytes than expected) never verifies
	// to content/md5, so the delete is refused. (spec section 10 path-11)
	it('test_never_delete_on_drift', async () => {
		const backend = new MemoryBackend({ capabilities: NO_SERVER_CHECKSUM });
		const stored = bytesOf('these are the WRONG bytes now');
		await backend.seedObject('k', stored, { etag: '"opaque"' });
		const expectation = await expectationFor(bytesOf('these are the right bytes okay')); // same length, different content
		let deleteCalls = 0;
		const decision = await verifyBeforeDelete(backend, 'k', expectation, () => {
			deleteCalls++;
			return Promise.resolve();
		});
		expect(decision.deleted).toBe(false);
		expect(deleteCalls).toBe(0);
	});
});

describe('verify ladder property tests (la-p2-08)', () => {
	// prop_gate_is_threshold :: the gate is a monotonic rank threshold.
	it('prop_gate_is_threshold', () => {
		fc.assert(
			fc.property(fc.constantFrom(...ALL_TIERS), fc.constantFrom(...ALL_TIERS), (tier, min) => {
				expect(canHardDelete(tier, { minimumTier: min })).toBe(RANK[tier] >= RANK[min]);
			}),
			{ numRuns: 100 },
		);
	});

	// prop_asserted_optin_allows_all :: allowAssertedDelete lowers the floor fully.
	it('prop_asserted_optin_allows_all', () => {
		fc.assert(
			fc.property(fc.constantFrom(...ALL_TIERS), (tier) => {
				expect(canHardDelete(tier, { allowAssertedDelete: true })).toBe(true);
			}),
			{ numRuns: 50 },
		);
	});
});

describe('verify ladder failure injection (la-p2-08)', () => {
	// The ladder never throws on a HEAD failure; it reports asserted so the gate
	// refuses (no HEAD -> no delete).
	it('fault_head_failure_is_asserted_not_throw', async () => {
		const backend = new MemoryBackend();
		backend.faults.head = () => {
			throw new Error('AccessDenied');
		};
		const result = await verifyByLadder(backend, 'k', await expectationFor(bytesOf('x')));
		expect(result.tier).toBe('asserted');
	});

	// ladderVerifier adapts the ladder to the pipeline's Verifier contract: ok is
	// true only for a content/md5 tier.
	it('fault_ladder_verifier_ok_only_for_proven_tiers', async () => {
		const backend = new MemoryBackend();
		const bytes = bytesOf('proven');
		await backend.put('k', bytes, bytes.length, { checksumSha256: await sha256Base64(bytes) });
		const ok = await ladderVerifier(backend, 'k', {
			hash: await sha256Hex(bytes),
			checksumBase64: await sha256Base64(bytes),
			size: bytes.length,
		});
		expect(ok.ok).toBe(true);
		expect(ok.tier).toBe('content');

		const empty = new MemoryBackend();
		const bad = await ladderVerifier(empty, 'missing', {
			hash: await sha256Hex(bytes),
			checksumBase64: await sha256Base64(bytes),
			size: bytes.length,
		});
		expect(bad.ok).toBe(false);
	});

	// A delete callback that throws surfaces (the caller decides), but the decision
	// still records that verification passed.
	it('fault_delete_callback_throw_surfaces', async () => {
		const backend = new MemoryBackend();
		const bytes = bytesOf('y');
		await backend.put('k', bytes, bytes.length, { checksumSha256: await sha256Base64(bytes) });
		await expect(
			verifyBeforeDelete(backend, 'k', await expectationFor(bytes), () => Promise.reject(new Error('delete failed'))),
		).rejects.toThrow('delete failed');
	});
});
