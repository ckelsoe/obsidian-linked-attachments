import fc from 'fast-check';
import { layoutHashKey, adoptExternalKey, supersedingKey, applyVaultRename } from './layout';
import { PointerRecord, requireS3Backend } from '../pointer/codec';

// Tier 0: pure key derivation. No backend, no network.

const HASH_A = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const HASH_B = '60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752';

function baseRecord(): PointerRecord {
	return {
		laVersion: 1,
		id: 'ID1',
		hash: HASH_A,
		backends: [
			{
				type: 's3',
				bucket: 's3-dev-test',
				key: 'charles-main/31-books/Romans/Cranfield--9f86d0.pdf',
				keyKind: 'hash',
			},
		],
		originalName: 'Cranfield.pdf',
		originalExt: 'pdf',
		originalPath: '31-books/Romans/Cranfield.pdf',
		byteSize: 1024,
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

// A 64-char lowercase-hex sha256, built from primitives that exist across
// fast-check versions (v4 removed fc.hexaString).
const hex64 = fc
	.array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
	.map((nibbles) => nibbles.map((n) => n.toString(16)).join(''));

function hasControlChar(value: string): boolean {
	for (const ch of value) {
		const code = ch.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) {
			return true;
		}
	}
	return false;
}

describe('key layout acceptance (la-p1-04)', () => {
	// AC1 :: key = vault-path-mirror + "--" + short-hash + ext. (spec section 3)
	it('test_readable_mirror', () => {
		const assignment = layoutHashKey({
			vaultPrefix: 'charles-main',
			originalPath: '31-books/Romans/Cranfield.pdf',
			hash: HASH_A,
		});
		expect(assignment.key).toBe('charles-main/31-books/Romans/Cranfield--9f86d0.pdf');
		expect(assignment.keyKind).toBe('hash');
	});

	// AC2 :: two distinct-byte files at the same path produce distinct keys
	// (the short-hash suffix; spec section 10 path-11 overwrite self-detect).
	it('test_hash_suffix_collision_safe', () => {
		const a = layoutHashKey({ vaultPrefix: 'v', originalPath: 'books/x.pdf', hash: HASH_A });
		const b = layoutHashKey({ vaultPrefix: 'v', originalPath: 'books/x.pdf', hash: HASH_B });
		expect(a.key).not.toBe(b.key);
	});

	// AC3 :: a vault rename is metadata-only; the key (born once) does not change.
	// (spec section 3 key born-once, rename never triggers an S3 copy)
	it('test_key_immutable_vs_rename', () => {
		const record = baseRecord();
		const renamed = applyVaultRename(record, '99-archive/Cranfield-moved.pdf');
		expect(requireS3Backend(renamed).key).toBe(requireS3Backend(record).key);
		expect(renamed.hash).toBe(record.hash);
		expect(renamed.originalPath).toBe('99-archive/Cranfield-moved.pdf');
		expect(renamed.originalName).toBe('Cranfield-moved.pdf');
		expect(renamed.originalExt).toBe('pdf');
	});

	// AC4 :: plugin-placed -> keyKind "hash"; foreign object -> keyKind "external".
	// (spec section 5)
	it('test_keyKind_discriminator', () => {
		expect(layoutHashKey({ vaultPrefix: 'v', originalPath: 'a.pdf', hash: HASH_A }).keyKind).toBe('hash');
		const foreign = adoptExternalKey('someone-elses/arbitrary-object.bin');
		expect(foreign.keyKind).toBe('external');
		expect(foreign.key).toBe('someone-elses/arbitrary-object.bin');
	});

	// A path with no directory mirrors directly under the prefix.
	it('test_root_level_file', () => {
		expect(layoutHashKey({ vaultPrefix: 'v', originalPath: 'notes.txt', hash: HASH_A }).key).toBe('v/notes--9f86d0.txt');
	});

	// A file with no extension yields a key with no trailing dot.
	it('test_no_extension', () => {
		expect(layoutHashKey({ vaultPrefix: 'v', originalPath: 'docs/LICENSE', hash: HASH_A }).key).toBe('v/docs/LICENSE--9f86d0');
	});
});

describe('key layout property tests (la-p1-04)', () => {
	// prop_reupload_is_additive :: re-uploading different bytes at the same path
	// produces a new key (old retained in the supersedes chain). (spec section 10)
	it('prop_reupload_is_additive', () => {
		fc.assert(
			fc.property(
				hex64,
				hex64,
				(oldHash, newHash) => {
					fc.pre(oldHash.slice(0, 6) !== newHash.slice(0, 6));
					const input = { vaultPrefix: 'v', originalPath: 'budget/2026.xlsx' };
					const oldKey = layoutHashKey({ ...input, hash: oldHash });
					const next = supersedingKey({ ...input, hash: newHash }, oldKey.key);
					expect(next.key).not.toBe(oldKey.key);
					expect(next.supersedes).toBe(oldKey.key);
					expect(next.keyKind).toBe('hash');
				},
			),
			{ numRuns: 200 },
		);
	});

	// prop_deterministic :: key derivation is a pure function of its inputs.
	it('prop_deterministic', () => {
		fc.assert(
			fc.property(fc.string(), hex64, (path, hash) => {
				const a = layoutHashKey({ vaultPrefix: 'v', originalPath: path, hash });
				const b = layoutHashKey({ vaultPrefix: 'v', originalPath: path, hash });
				expect(a.key).toBe(b.key);
			}),
			{ numRuns: 200 },
		);
	});
});

describe('key layout failure injection (la-p1-04)', () => {
	// Unicode, spaces, tabs/newlines, and 260+ char paths must yield a
	// deterministic key with no control characters, never a throw.
	it('fault_unicode_spaces_long_path_safe', () => {
		const longSeg = 'a'.repeat(300);
		const paths = [
			'books/Café notes/Über.pdf',
			'a b c/d e f.txt',
			`${longSeg}/${longSeg}.pdf`,
			'tabs\tand\nnewlines.pdf',
			'   /   .pdf',
		];
		for (const path of paths) {
			expect(() => layoutHashKey({ vaultPrefix: 'v', originalPath: path, hash: HASH_A })).not.toThrow();
			const key = layoutHashKey({ vaultPrefix: 'v', originalPath: path, hash: HASH_A }).key;
			expect(key.length).toBeGreaterThan(0);
			expect(hasControlChar(key)).toBe(false);
			// deterministic
			expect(layoutHashKey({ vaultPrefix: 'v', originalPath: path, hash: HASH_A }).key).toBe(key);
		}
	});
});
