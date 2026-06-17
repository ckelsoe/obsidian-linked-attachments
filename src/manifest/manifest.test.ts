import fc from 'fast-check';
import {
	Manifest,
	ManifestEntry,
	OBJECT_METADATA_KEYS,
	buildManifestFromPointers,
	buildManifestFromBucket,
	mergeManifests,
	serializeManifest,
	parseManifest,
	findByKey,
	findByHash,
	hasKey,
} from './manifest';
import { PointerRecord } from '../pointer/codec';

// Tier 0: pure cache data structure. No backend, no network.

const HASH_A = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

function recordFor(key: string, overrides: Partial<PointerRecord> = {}): PointerRecord {
	return {
		laVersion: 1,
		id: `id-${key}`,
		hash: HASH_A,
		bucket: 's3-dev-test',
		key,
		keyKind: 'hash',
		originalName: 'x.pdf',
		originalExt: 'pdf',
		originalPath: `books/${key}.pdf`,
		byteSize: 2048,
		contentType: 'application/pdf',
		copyState: 'offloaded',
		verificationTier: 'content',
		remoteChecksum: null,
		checksumAlgo: null,
		partSize: null,
		partCount: null,
		offloadedAt: '2026-06-16T12:00:00.000Z',
		sourceVersion: null,
		supersedes: null,
	};
}

describe('manifest cache acceptance (la-p1-05)', () => {
	// AC1 :: building from pointer records produces one entry per key carrying the
	// identity fields. (spec section 3 reconstructable from pointers)
	it('test_build_from_pointers', () => {
		const manifest = buildManifestFromPointers([
			{ pointerPath: 'books/a.pdf.md', record: recordFor('k-a') },
			{ pointerPath: 'books/b.pdf.md', record: recordFor('k-b') },
		]);
		expect(Object.keys(manifest.entries).sort()).toEqual(['k-a', 'k-b']);
		expect(findByKey(manifest, 'k-a')?.pointerPath).toBe('books/a.pdf.md');
		expect(findByKey(manifest, 'k-a')?.hash).toBe(HASH_A);
	});

	// AC2 :: building from ListObjects + metadata classifies objects: ours (with
	// metadata) -> keyKind hash; foreign (no metadata) -> external + hash null.
	// (spec section 3 recovery path, section 9 external-object survival)
	it('test_build_from_bucket', () => {
		const manifest = buildManifestFromBucket('s3-dev-test', [
			{
				key: 'charles-main/books/a--9f86d0.pdf',
				byteSize: 2048,
				metadata: {
					[OBJECT_METADATA_KEYS.sha256]: HASH_A,
					[OBJECT_METADATA_KEYS.id]: 'id-a',
					[OBJECT_METADATA_KEYS.originalPath]: 'books/a.pdf',
				},
			},
			{ key: 'someone-elses/foreign.bin', byteSize: 10 },
		]);
		const ours = findByKey(manifest, 'charles-main/books/a--9f86d0.pdf');
		expect(ours?.keyKind).toBe('hash');
		expect(ours?.hash).toBe(HASH_A);
		expect(ours?.verificationTier).toBe('asserted');
		const foreign = findByKey(manifest, 'someone-elses/foreign.bin');
		expect(foreign?.keyKind).toBe('external');
		expect(foreign?.hash).toBeNull();
	});

	// AC3 :: on a per-key conflict the pointer-derived entry wins over the cached
	// one. (spec section 10 pointers > LIST > any manifest copy)
	it('test_pointers_win_conflict', () => {
		const cached = buildManifestFromBucket('s3-dev-test', [{ key: 'k', byteSize: 999 }]);
		const authoritative = buildManifestFromPointers([
			{ pointerPath: 'books/x.pdf.md', record: recordFor('k', { byteSize: 2048 }) },
		]);
		const merged = mergeManifests(cached, authoritative);
		expect(findByKey(merged, 'k')?.byteSize).toBe(2048);
		expect(findByKey(merged, 'k')?.keyKind).toBe('hash');
	});

	// AC4 :: serialize then parse returns the same manifest.
	it('test_serialize_roundtrip', () => {
		const manifest = buildManifestFromPointers([{ pointerPath: 'p.md', record: recordFor('k') }]);
		const result = parseManifest(serializeManifest(manifest));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.manifest).toEqual(manifest);
		}
	});

	// AC5 :: a corrupt manifest parses to a discardable result, never a throw and
	// never a partial manifest. (spec section 10 manifest is output not input)
	it('test_parse_corrupt_is_discardable', () => {
		expect(parseManifest('not json at all {{{').ok).toBe(false);
		expect(parseManifest('{"version":1}').ok).toBe(false); // missing entries
		expect(parseManifest('[]').ok).toBe(false); // wrong root shape
		expect(parseManifest('{"version":1,"entries":{"k":{"key":"k"}}}').ok).toBe(false); // entry missing fields
	});

	// AC6 :: lookup by key and by hash (dedup-on-adopt and reconciliation depend on
	// these). (spec section 4 adopt hides objects that already have a pointer)
	it('test_lookup_by_key_and_hash', () => {
		const manifest = buildManifestFromPointers([
			{ pointerPath: 'a.md', record: recordFor('k-a', { hash: HASH_A }) },
			{ pointerPath: 'b.md', record: recordFor('k-b', { hash: HASH_A }) },
		]);
		expect(hasKey(manifest, 'k-a')).toBe(true);
		expect(hasKey(manifest, 'missing')).toBe(false);
		expect(findByHash(manifest, HASH_A).map((e) => e.key).sort()).toEqual(['k-a', 'k-b']);
	});
});

describe('manifest cache property tests (la-p1-05)', () => {
	const entryArb: fc.Arbitrary<ManifestEntry> = fc.record({
		key: fc.string({ minLength: 1 }),
		keyKind: fc.constantFrom('hash' as const, 'external' as const),
		id: fc.string(),
		hash: fc.option(fc.string({ minLength: 8 }), { nil: null }),
		bucket: fc.string(),
		byteSize: fc.nat(),
		verificationTier: fc.constantFrom('content' as const, 'md5' as const, 'existence' as const, 'asserted' as const),
		originalPath: fc.string(),
		pointerPath: fc.option(fc.string(), { nil: null }),
		remoteChecksum: fc.option(fc.string(), { nil: null }),
	});

	// prop_serialize_roundtrip :: any manifest survives serialize -> parse.
	it('prop_serialize_roundtrip', () => {
		fc.assert(
			fc.property(fc.uniqueArray(entryArb, { selector: (e) => e.key }), (entries) => {
				const manifest: Manifest = { version: 1, entries: {} };
				for (const entry of entries) {
					manifest.entries[entry.key] = entry;
				}
				const result = parseManifest(serializeManifest(manifest));
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.manifest).toEqual(manifest);
				}
			}),
			{ numRuns: 200 },
		);
	});

	// prop_build_is_order_independent :: building from pointers is keyed by key, so
	// a permutation of the same records yields an equal manifest.
	it('prop_build_is_order_independent', () => {
		fc.assert(
			fc.property(fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 0, maxLength: 20 }), (keys) => {
				const sources = keys.map((k) => ({ pointerPath: `${k}.md`, record: recordFor(k) }));
				const forward = buildManifestFromPointers(sources);
				const reversed = buildManifestFromPointers([...sources].reverse());
				expect(reversed).toEqual(forward);
			}),
			{ numRuns: 100 },
		);
	});
});

describe('manifest cache failure injection (la-p1-05)', () => {
	// Truncated JSON is discardable, not a crash.
	it('fault_truncated_json_discardable', () => {
		const manifest = buildManifestFromPointers([{ pointerPath: 'p.md', record: recordFor('k') }]);
		const text = serializeManifest(manifest);
		const truncated = text.slice(0, Math.floor(text.length / 2));
		expect(() => parseManifest(truncated)).not.toThrow();
		expect(parseManifest(truncated).ok).toBe(false);
	});

	// A wrong-typed field (byteSize as a string) is discardable, never coerced.
	it('fault_wrong_typed_field_discardable', () => {
		const bad = '{"version":1,"entries":{"k":{"key":"k","keyKind":"hash","id":"i","hash":null,"bucket":"b","byteSize":"big","verificationTier":"asserted","originalPath":"p","pointerPath":null,"remoteChecksum":null}}}';
		expect(parseManifest(bad).ok).toBe(false);
	});

	// A duplicate key in the pointer input resolves deterministically (last wins),
	// never throws.
	it('fault_duplicate_key_last_wins', () => {
		const manifest = buildManifestFromPointers([
			{ pointerPath: 'first.md', record: recordFor('k', { byteSize: 1 }) },
			{ pointerPath: 'second.md', record: recordFor('k', { byteSize: 2 }) },
		]);
		expect(Object.keys(manifest.entries)).toEqual(['k']);
		expect(findByKey(manifest, 'k')?.byteSize).toBe(2);
		expect(findByKey(manifest, 'k')?.pointerPath).toBe('second.md');
	});
});
