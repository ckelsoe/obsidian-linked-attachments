import fc from 'fast-check';
import { buildHashIndex, lookupByHash, rememberObject, HashIndex } from './dedup';
import { PointerRecord, requireS3Backend } from '../pointer/codec';
import { PointerSource } from '../manifest/manifest';

// Tier 0: the hash -> object index is pure (pointer records in, a map out). No
// backend, no network. It is the rebuildable-from-pointers index the offload
// dedup pre-check consults (spec section 10 content-dedup invariant).

function record(overrides: Partial<PointerRecord> = {}): PointerRecord {
	return {
		laVersion: 1,
		id: 'ID',
		hash: 'a'.repeat(64),
		backends: [
			{
				type: 's3',
				bucket: 's3-dev-test',
				key: 'charles-main/books/Cranfield--aaaaaa.pdf',
				keyKind: 'hash',
			},
		],
		originalName: 'Cranfield.pdf',
		originalExt: 'pdf',
		originalPath: 'books/Cranfield.pdf',
		byteSize: 10,
		contentType: 'application/pdf',
		copyState: 'offloaded',
		verificationTier: 'content',
		remoteChecksum: null,
		checksumAlgo: 'sha256',
		partSize: null,
		partCount: null,
		offloadedAt: '2026-06-18T00:00:00.000Z',
		sourceVersion: null,
		supersedes: null,
		...overrides,
	};
}

function source(rec: PointerRecord, pointerPath = `${rec.originalPath}.md`): PointerSource {
	return { pointerPath, record: rec };
}

// fast-check v4 removed fc.hexaString; build a 64-char hex arbitrary by hand.
const hex64 = fc
	.array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
	.map((digits) => digits.map((d) => d.toString(16)).join(''));

describe('content-dedup hash index (la-p5-26)', () => {
	// AC1 :: the index maps a pointer's content hash to its existing object.
	it('test_index_built_from_pointers', () => {
		const rec = record();
		const index = buildHashIndex([source(rec)]);
		const target = lookupByHash(index, rec.hash as string);
		const s3 = requireS3Backend(rec);
		expect(target).toEqual({ key: s3.key, bucket: s3.bucket, keyKind: s3.keyKind });
	});

	// AC2 :: an adopted/foreign pointer (hash null) is NEVER a dedup target - we
	// cannot claim its bytes match, so it must not link other files to it.
	it('test_index_skips_null_hash', () => {
		const index = buildHashIndex([
			source(
				record({
					hash: null,
					backends: [{ type: 's3', bucket: 's3-dev-test', key: 'charles-main/books/Cranfield--aaaaaa.pdf', keyKind: 'external' }],
				}),
			),
		]);
		expect(index.size).toBe(0);
	});

	// AC3 :: two pointers for the same bytes -> one index entry (the first wins);
	// lookup is unambiguous.
	it('test_first_pointer_wins', () => {
		const first = record({
			backends: [{ type: 's3', bucket: 's3-dev-test', key: 'charles-main/a--aaaaaa.pdf', keyKind: 'hash' }],
			originalPath: 'a.pdf',
		});
		const second = record({
			backends: [{ type: 's3', bucket: 's3-dev-test', key: 'charles-main/b--aaaaaa.pdf', keyKind: 'hash' }],
			originalPath: 'b.pdf',
		});
		const index = buildHashIndex([source(first), source(second)]);
		expect(index.size).toBe(1);
		expect(lookupByHash(index, first.hash as string)?.key).toBe(requireS3Backend(first).key);
	});

	// AC4 :: rememberObject lets a just-offloaded object be a dedup target for a
	// later identical file in the same batch (the vault scan predates this offload).
	it('test_remember_adds_to_index', () => {
		const index: HashIndex = new Map();
		const rec = record();
		rememberObject(index, rec);
		expect(lookupByHash(index, rec.hash as string)?.key).toBe(requireS3Backend(rec).key);
	});

	// AC5 :: a miss returns null (no false dedup target).
	it('test_lookup_miss_is_null', () => {
		const index = buildHashIndex([source(record())]);
		expect(lookupByHash(index, 'f'.repeat(64))).toBeNull();
	});

	it('test_remember_null_hash_noop', () => {
		const index: HashIndex = new Map();
		rememberObject(index, record({ hash: null }));
		expect(index.size).toBe(0);
	});
});

describe('content-dedup hash index property (la-p5-26)', () => {
	// prop :: every offloaded record with a hash is findable by that hash, and
	// every distinct hash yields exactly one entry (the index never invents a key).
	it('prop_every_hashed_record_is_indexed', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						hash: hex64,
						key: fc.string({ minLength: 1 }),
					}),
					{ minLength: 1 },
				),
				(rows) => {
					const sources = rows.map((r, i) =>
						source(
							record({
								hash: r.hash,
								backends: [{ type: 's3', bucket: 's3-dev-test', key: `${r.key}-${i}`, keyKind: 'hash' }],
							}),
							`p${i}.md`,
						),
					);
					const index = buildHashIndex(sources);
					const distinctHashes = new Set(rows.map((r) => r.hash));
					expect(index.size).toBe(distinctHashes.size);
					for (const hash of distinctHashes) {
						expect(lookupByHash(index, hash)).not.toBeNull();
					}
				},
			),
			{ numRuns: 100 },
		);
	});
});
