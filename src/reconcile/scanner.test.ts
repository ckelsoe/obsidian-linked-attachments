import fc from 'fast-check';
import {
	reconcile,
	scanReconcile,
	linkUnlinked,
	BucketObjectInfo,
	ReconcileFinding,
} from './scanner';
import { MemoryBackend } from '../storage/memory-backend';
import { StorageBackend } from '../storage/backend';
import { ManifestEntry } from '../manifest/manifest';

// Tier 0: the reconciliation diff is pure; the orchestrator runs LIST/HEAD
// against MemoryBackend. The governing rule is surface/offer/flag, never
// auto-destroy - a call-counting backend proves zero put/delete.

function entry(key: string, overrides: Partial<ManifestEntry> = {}): ManifestEntry {
	return {
		key,
		keyKind: 'hash',
		id: `id-${key}`,
		hash: 'h',
		bucket: 's3-dev-test',
		byteSize: 100,
		verificationTier: 'content',
		originalPath: key,
		pointerPath: `${key}.md`,
		remoteChecksum: null,
		...overrides,
	};
}

function obj(key: string, overrides: Partial<BucketObjectInfo> = {}): BucketObjectInfo {
	return { key, size: 100, etag: '"e"', ...overrides };
}

interface Counts {
	list: number;
	head: number;
	put: number;
	delete: number;
}

function counting(backend: StorageBackend): { backend: StorageBackend; counts: Counts } {
	const counts: Counts = { list: 0, head: 0, put: 0, delete: 0 };
	const wrapped: StorageBackend = {
		capabilities: backend.capabilities,
		put: (key, body, size, opts) => {
			counts.put++;
			return backend.put(key, body, size, opts);
		},
		get: (key, range) => backend.get(key, range),
		head: (key) => {
			counts.head++;
			return backend.head(key);
		},
		delete: (key) => {
			counts.delete++;
			return backend.delete(key);
		},
		list: (prefix, opts) => {
			counts.list++;
			return backend.list(prefix, opts);
		},
		displayKey: (key) => backend.displayKey(key),
	};
	return { backend: wrapped, counts };
}

const adoptOptions = { bucket: 's3-dev-test', newId: () => 'ID', now: () => '2026-06-16T12:00:00.000Z' };

function outcomesByKey(findings: ReconcileFinding[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const f of findings) {
		out[f.key] = f.outcome;
	}
	return out;
}

describe('reconciliation scanner acceptance (la-p2-10)', () => {
	// AC1 :: a pointer with a matching object is healthy, stamped with a tier.
	it('test_healthy_match', () => {
		const findings = reconcile([entry('k', { byteSize: 100 })], [obj('k', { size: 100 })]);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.outcome).toBe('healthy');
		expect(findings[0]?.stampedTier).toBe('existence');
	});

	// AC2 :: a pointer with no object is broken / tombstone (flagged, not repaired).
	it('test_broken_tombstone', () => {
		const findings = reconcile([entry('k')], []);
		expect(findings[0]?.outcome).toBe('broken');
	});

	// AC3 :: an object with no pointer is an unlinked candidate (offer link-it).
	it('test_unlinked_candidate', () => {
		const findings = reconcile([], [obj('k')]);
		expect(findings[0]?.outcome).toBe('unlinked');
	});

	// AC4 :: a pointer + object whose sizes disagree is drift (flagged loudly).
	it('test_drift_size_mismatch', () => {
		const findings = reconcile([entry('k', { byteSize: 100 })], [obj('k', { size: 200 })]);
		expect(findings[0]?.outcome).toBe('drift');
	});

	// AC5 :: same size but disagreeing checksums is also drift (spec section 10
	// path-11 external overwrite self-detect).
	it('test_drift_checksum_mismatch', () => {
		const findings = reconcile(
			[entry('k', { byteSize: 100, remoteChecksum: 'AAAA' })],
			[obj('k', { size: 100, checksumSha256: 'BBBB' })],
		);
		expect(findings[0]?.outcome).toBe('drift');
	});

	// AC6 :: link-it builds an adopted pointer per unlinked candidate (the one v1
	// remediation action).
	it('test_link_it_builds_pointers', () => {
		const findings = reconcile([], [obj('docs/new.pdf', { size: 50 })]);
		const pointers = linkUnlinked(findings, {}, adoptOptions);
		expect(pointers).toHaveLength(1);
		expect(pointers[0]?.pointerPath).toBe('docs/new.pdf.md');
		expect(pointers[0]?.record.verificationTier).toBe('asserted');
		expect(pointers[0]?.record.key).toBe('docs/new.pdf');
	});

	// AC7 :: a full scan issues only LIST/HEAD - never a put or delete (surface,
	// offer, flag; never auto-destroy). (spec section 6)
	it('test_never_mutates_bucket', async () => {
		const mem = new MemoryBackend();
		await mem.seedObject('a/x.pdf', new TextEncoder().encode('hello'));
		const { backend, counts } = counting(mem);
		await scanReconcile(backend, [entry('a/x.pdf', { byteSize: 5 })], { prefix: 'a/', deep: true });
		expect(counts.put).toBe(0);
		expect(counts.delete).toBe(0);
		expect(counts.list).toBeGreaterThan(0);
	});

	// AC8 :: a mixed input yields exactly the four outcomes, correctly partitioned.
	it('test_all_four_in_one_scan', () => {
		const findings = reconcile(
			[
				entry('healthy', { byteSize: 100 }),
				entry('broken'),
				entry('drift', { byteSize: 100 }),
			],
			[obj('healthy', { size: 100 }), obj('drift', { size: 999 }), obj('unlinked', { size: 10 })],
		);
		expect(outcomesByKey(findings)).toEqual({
			healthy: 'healthy',
			broken: 'broken',
			drift: 'drift',
			unlinked: 'unlinked',
		});
	});

	// The orchestrator reconciles real LIST output against the pointers.
	it('test_orchestrator_lists_and_diffs', async () => {
		const mem = new MemoryBackend();
		await mem.seedObject('a/keep.pdf', new TextEncoder().encode('12345'));
		await mem.seedObject('a/orphan.pdf', new TextEncoder().encode('99'));
		const findings = await scanReconcile(mem, [entry('a/keep.pdf', { byteSize: 5 })], { prefix: 'a/' });
		expect(outcomesByKey(findings)).toEqual({ 'a/keep.pdf': 'healthy', 'a/orphan.pdf': 'unlinked' });
	});
});

describe('reconciliation scanner property tests (la-p2-10)', () => {
	// prop_every_item_classified :: every pointer key and every object key appears
	// in the findings; pointer keys get healthy/broken/drift, object-only keys get
	// unlinked. No key dropped.
	it('prop_every_item_classified', () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { maxLength: 12 }),
				fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/), { maxLength: 12 }),
				(pointerKeys, objectKeys) => {
					const findings = reconcile(
						pointerKeys.map((k) => entry(k)),
						objectKeys.map((k) => obj(k)),
					);
					const pointerSet = new Set(pointerKeys);
					const objectSet = new Set(objectKeys);
					// every pointer key is present
					for (const k of pointerKeys) {
						expect(findings.some((f) => f.key === k && f.pointer !== null)).toBe(true);
					}
					// every object-only key is an unlinked finding
					for (const k of objectKeys) {
						if (!pointerSet.has(k)) {
							expect(findings.some((f) => f.key === k && f.outcome === 'unlinked')).toBe(true);
						}
					}
					// no finding invents a key
					for (const f of findings) {
						expect(pointerSet.has(f.key) || objectSet.has(f.key)).toBe(true);
					}
				},
			),
			{ numRuns: 100 },
		);
	});

	// prop_no_false_healthy :: a healthy finding always has a size-matching object.
	it('prop_no_false_healthy', () => {
		fc.assert(
			fc.property(fc.nat({ max: 1000 }), fc.nat({ max: 1000 }), (pSize, oSize) => {
				const findings = reconcile([entry('k', { byteSize: pSize })], [obj('k', { size: oSize })]);
				if (findings[0]?.outcome === 'healthy') {
					expect(oSize).toBe(pSize);
				}
			}),
			{ numRuns: 200 },
		);
	});
});

describe('reconciliation scanner failure injection (la-p2-10)', () => {
	// An adopted (external, hash-null) pointer with a matching object is healthy,
	// not drift - there is no checksum to disagree on.
	it('fault_external_pointer_no_false_drift', () => {
		const findings = reconcile(
			[entry('k', { keyKind: 'external', hash: null, remoteChecksum: null, byteSize: 100 })],
			[obj('k', { size: 100 })],
		);
		expect(findings[0]?.outcome).toBe('healthy');
	});

	// A non-deep scan (LIST only) cannot read checksums; it still classifies by
	// size without issuing HEAD.
	it('fault_shallow_scan_no_head', async () => {
		const mem = new MemoryBackend();
		await mem.seedObject('a/x.pdf', new TextEncoder().encode('hello'));
		const { backend, counts } = counting(mem);
		const findings = await scanReconcile(backend, [entry('a/x.pdf', { byteSize: 5 })], { prefix: 'a/', deep: false });
		expect(counts.head).toBe(0);
		expect(findings[0]?.outcome).toBe('healthy');
	});

	// Empty inputs yield no findings.
	it('fault_empty_inputs', () => {
		expect(reconcile([], [])).toHaveLength(0);
	});
});
