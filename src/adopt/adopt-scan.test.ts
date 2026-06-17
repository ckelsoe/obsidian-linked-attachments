import fc from 'fast-check';
import {
	scanForAdoption,
	buildAdoptedPointer,
	adoptByKey,
	AdoptRow,
} from './adopt-scan';
import { MemoryBackend } from '../storage/memory-backend';
import { StorageBackend } from '../storage/backend';
import { OBJECT_METADATA_KEYS } from '../manifest/manifest';

// Tier 0: adopt against MemoryBackend. The moat guarantee is that bulk adopt is
// LIST-only - zero head/get - so a call-counting wrapper backs the lock test.

interface Counts {
	list: number;
	head: number;
	get: number;
}

function counting(backend: StorageBackend): { backend: StorageBackend; counts: Counts } {
	const counts: Counts = { list: 0, head: 0, get: 0 };
	const wrapped: StorageBackend = {
		capabilities: backend.capabilities,
		put: (key, body, size, opts) => backend.put(key, body, size, opts),
		get: (key, range) => {
			counts.get++;
			return backend.get(key, range);
		},
		head: (key) => {
			counts.head++;
			return backend.head(key);
		},
		delete: (key) => backend.delete(key),
		list: (prefix, opts) => {
			counts.list++;
			return backend.list(prefix, opts);
		},
		displayKey: (key) => backend.displayKey(key),
	};
	return { backend: wrapped, counts };
}

async function seedKeys(backend: MemoryBackend, keys: string[]): Promise<void> {
	for (const key of keys) {
		await backend.seedObject(key, new TextEncoder().encode(key));
	}
}

const NEW_ID = (() => {
	let n = 0;
	return () => `ID-${n++}`;
})();

const options = { bucket: 's3-dev-test', newId: NEW_ID, now: () => '2026-06-16T12:00:00.000Z' };

describe('adopt-from-bucket acceptance (la-p2-09)', () => {
	// AC1 :: the scan lists keys under the prefix, reading the basename as the
	// display name and the size from the listing.
	it('test_scan_lists_under_prefix', async () => {
		const backend = new MemoryBackend();
		await seedKeys(backend, ['docs/a.pdf', 'docs/b.epub', 'other/c.bin']);
		const result = await scanForAdoption({
			backend,
			prefix: 'docs/',
			existingPointerKeys: new Set(),
			existingVaultPaths: new Set(),
		});
		expect(result.rows.map((r) => r.key).sort()).toEqual(['docs/a.pdf', 'docs/b.epub']);
		expect(result.rows.find((r) => r.key === 'docs/a.pdf')?.displayName).toBe('a.pdf');
	});

	// AC2 (THE LOCK TEST) :: bulk-adopting 300 keys creates 300 pointers with ZERO
	// head/get calls. (spec section 4 scope wall)
	it('test_bulk_adopt_zero_head_get', async () => {
		const mem = new MemoryBackend();
		const keys = Array.from({ length: 300 }, (_unused, i) => `bulk/file-${i}.pdf`);
		await seedKeys(mem, keys);
		const { backend, counts } = counting(mem);
		const result = await scanForAdoption({
			backend,
			prefix: 'bulk/',
			existingPointerKeys: new Set(),
			existingVaultPaths: new Set(),
			pageSize: 50,
		});
		const adoptable = result.rows.filter((r) => r.status === 'adoptable');
		const pointers = adoptable.map((row) => buildAdoptedPointer(row, options));
		expect(pointers).toHaveLength(300);
		expect(counts.head).toBe(0);
		expect(counts.get).toBe(0);
		expect(counts.list).toBeGreaterThan(0);
	});

	// AC3 :: a key that already has a pointer is marked already-adopted (hidden).
	it('test_hides_already_adopted', async () => {
		const backend = new MemoryBackend();
		await seedKeys(backend, ['docs/a.pdf', 'docs/b.pdf']);
		const result = await scanForAdoption({
			backend,
			prefix: 'docs/',
			existingPointerKeys: new Set(['docs/a.pdf']),
			existingVaultPaths: new Set(),
		});
		expect(result.rows.find((r) => r.key === 'docs/a.pdf')?.status).toBe('already-adopted');
		expect(result.rows.find((r) => r.key === 'docs/b.pdf')?.status).toBe('adoptable');
	});

	// AC4 :: a mirrored pointer path that collides with an existing vault path is
	// skip-and-report (collision), never an overwrite. (spec section 4)
	it('test_collision_skip_and_report', async () => {
		const backend = new MemoryBackend();
		await seedKeys(backend, ['docs/a.pdf']);
		const result = await scanForAdoption({
			backend,
			prefix: 'docs/',
			existingPointerKeys: new Set(),
			existingVaultPaths: new Set(['docs/a.pdf.md']),
		});
		expect(result.rows.find((r) => r.key === 'docs/a.pdf')?.status).toBe('collision');
	});

	// AC5 :: prefix-strip + destination-folder produce the mirrored vault path and
	// the .md pointer path.
	it('test_prefix_strip_and_mirror', async () => {
		const backend = new MemoryBackend();
		await seedKeys(backend, ['charles-main/books/Romans/Cranfield.pdf']);
		const result = await scanForAdoption({
			backend,
			prefix: 'charles-main/',
			stripPrefix: 'charles-main/',
			destinationFolder: 'adopted',
			existingPointerKeys: new Set(),
			existingVaultPaths: new Set(),
		});
		const row = result.rows[0];
		expect(row?.vaultPath).toBe('adopted/books/Romans/Cranfield.pdf');
		expect(row?.pointerPath).toBe('adopted/books/Romans/Cranfield.pdf.md');
	});

	// AC6 :: an adopted pointer is ASSERTED, hash null, keyKind external, and keeps
	// the bucket key. Adoption never yields a verified tier. (spec section 4)
	it('test_adopted_pointer_is_asserted', async () => {
		const row: AdoptRow = {
			key: 'docs/report.pdf',
			displayName: 'report.pdf',
			size: 4096,
			vaultPath: 'docs/report.pdf',
			pointerPath: 'docs/report.pdf.md',
			status: 'adoptable',
		};
		const { record, pointerPath } = buildAdoptedPointer(row, options);
		expect(record.verificationTier).toBe('asserted');
		expect(record.hash).toBeNull();
		expect(record.keyKind).toBe('external');
		expect(record.key).toBe('docs/report.pdf');
		expect(record.byteSize).toBe(4096);
		expect(record.originalPath).toBe('docs/report.pdf');
		expect(pointerPath).toBe('docs/report.pdf.md');
	});

	// AC7 :: a re-run after adopting hides the now-pointered keys (idempotent).
	it('test_idempotent_rerun', async () => {
		const backend = new MemoryBackend();
		await seedKeys(backend, ['docs/a.pdf', 'docs/b.pdf']);
		const first = await scanForAdoption({ backend, prefix: 'docs/', existingPointerKeys: new Set(), existingVaultPaths: new Set() });
		const adopted = new Set(first.rows.filter((r) => r.status === 'adoptable').map((r) => r.key));
		const second = await scanForAdoption({ backend, prefix: 'docs/', existingPointerKeys: adopted, existingVaultPaths: new Set() });
		expect(second.rows.filter((r) => r.status === 'adoptable')).toHaveLength(0);
	});

	// AC8 :: paste-a-key adopts a single object with exactly one HEAD and zero
	// LIST; if our metadata is present it records the claimed hash. (spec section 4)
	it('test_paste_a_key_one_head', async () => {
		const mem = new MemoryBackend();
		await mem.seedObject('manual/x.pdf', new TextEncoder().encode('content'), {
			metadata: { [OBJECT_METADATA_KEYS.sha256]: 'claimedhash123' },
		});
		const { backend, counts } = counting(mem);
		const result = await adoptByKey(backend, 'manual/x.pdf', { vaultPath: 'manual/x.pdf' }, options);
		expect(counts.head).toBe(1);
		expect(counts.list).toBe(0);
		expect(counts.get).toBe(0);
		if ('record' in result) {
			expect(result.record.verificationTier).toBe('asserted');
			expect(result.record.hash).toBe('claimedhash123');
			expect(result.record.keyKind).toBe('hash');
		} else {
			throw new Error('expected a record');
		}
	});
});

describe('adopt-from-bucket property tests (la-p2-09)', () => {
	// prop_every_key_classified_once :: every listed key appears exactly once in
	// the rows with exactly one of the three statuses. No key dropped or doubled.
	it('prop_every_key_classified_once', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.uniqueArray(fc.stringMatching(/^[a-z0-9]{1,10}$/), { minLength: 0, maxLength: 30 }),
				fc.integer({ min: 1, max: 7 }),
				async (stems, pageSize) => {
					const mem = new MemoryBackend();
					const keys = stems.map((s) => `p/${s}.bin`);
					await seedKeys(mem, keys);
					const result = await scanForAdoption({
						backend: mem,
						prefix: 'p/',
						existingPointerKeys: new Set(),
						existingVaultPaths: new Set(),
						pageSize,
					});
					expect(result.rows.map((r) => r.key).sort()).toEqual([...keys].sort());
					for (const row of result.rows) {
						expect(['adoptable', 'already-adopted', 'collision']).toContain(row.status);
					}
				},
			),
			{ numRuns: 60 },
		);
	});
});

describe('adopt-from-bucket failure injection (la-p2-09)', () => {
	// Pagination: keys across many pages all appear once.
	it('fault_pagination_covers_all_keys', async () => {
		const mem = new MemoryBackend();
		const keys = Array.from({ length: 25 }, (_unused, i) => `pg/k${String(i).padStart(2, '0')}.bin`);
		await seedKeys(mem, keys);
		const { backend, counts } = counting(mem);
		const result = await scanForAdoption({ backend, prefix: 'pg/', existingPointerKeys: new Set(), existingVaultPaths: new Set(), pageSize: 4 });
		expect(result.rows.map((r) => r.key).sort()).toEqual([...keys].sort());
		expect(counts.list).toBeGreaterThan(1); // actually paged
	});

	// already-adopted takes precedence over a collision (a key that both has a
	// pointer and would collide is hidden, deterministically).
	it('fault_already_adopted_precedes_collision', async () => {
		const backend = new MemoryBackend();
		await seedKeys(backend, ['docs/a.pdf']);
		const result = await scanForAdoption({
			backend,
			prefix: 'docs/',
			existingPointerKeys: new Set(['docs/a.pdf']),
			existingVaultPaths: new Set(['docs/a.pdf.md']),
		});
		expect(result.rows.find((r) => r.key === 'docs/a.pdf')?.status).toBe('already-adopted');
	});

	// An empty bucket yields no rows and does not crash.
	it('fault_empty_bucket_no_rows', async () => {
		const backend = new MemoryBackend();
		const result = await scanForAdoption({ backend, prefix: 'none/', existingPointerKeys: new Set(), existingVaultPaths: new Set() });
		expect(result.rows).toHaveLength(0);
	});
});
