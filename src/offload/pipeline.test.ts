import fc from 'fast-check';
import {
	OffloadDeps,
	OffloadFile,
	offloadFile,
	checksumVerifier,
} from './pipeline';
import { MemoryBackend } from '../storage/memory-backend';
import { StorageBackend } from '../storage/backend';
import { OBJECT_METADATA_KEYS } from '../manifest/manifest';
import { sha256Base64 } from '../hash/sha256';

// Tier 0: the pipeline runs against MemoryBackend with injected vault side
// effects (writePointer / trashOriginal). No filesystem, no network.

function bytesOf(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

// A StorageBackend wrapper that records verb order, to assert O6 sequencing.
function logged(backend: StorageBackend, events: string[]): StorageBackend {
	return {
		capabilities: backend.capabilities,
		put: (key, body, size, opts) => {
			events.push('upload');
			return backend.put(key, body, size, opts);
		},
		head: (key) => {
			events.push('verify-head');
			return backend.head(key);
		},
		get: (key, range) => backend.get(key, range),
		delete: (key) => backend.delete(key),
		list: (prefix, opts) => backend.list(prefix, opts),
		displayKey: (key) => backend.displayKey(key),
	};
}

interface Harness {
	deps: OffloadDeps;
	events: string[];
	pointers: Map<string, string>;
	trashed: string[];
}

function makeHarness(backend: StorageBackend, overrides: Partial<OffloadDeps> = {}): Harness {
	const events: string[] = [];
	const pointers = new Map<string, string>();
	const trashed: string[] = [];
	const deps: OffloadDeps = {
		backend: logged(backend, events),
		bucket: 's3-dev-test',
		vaultPrefix: 'charles-main',
		writePointer: (pointerPath, content) => {
			events.push('commit');
			pointers.set(pointerPath, content);
			return Promise.resolve();
		},
		trashOriginal: (path) => {
			events.push('trash');
			trashed.push(path);
			return Promise.resolve();
		},
		newId: () => 'ID-FIXED',
		now: () => '2026-06-16T12:00:00.000Z',
		...overrides,
	};
	return { deps, events, pointers, trashed };
}

function file(path: string, content: string): OffloadFile {
	return { path, bytes: bytesOf(content), contentType: 'application/pdf' };
}

describe('offload pipeline acceptance (la-p2-07)', () => {
	// AC1 :: O6 order - upload, verify, commit pointer, then remove original.
	// (spec section 7.7 / section 10 O6)
	it('test_happy_path_o6_order', async () => {
		const backend = new MemoryBackend();
		const h = makeHarness(backend);
		const result = await offloadFile(file('books/Cranfield.pdf', 'the epistle to the romans'), h.deps);
		expect(result.ok).toBe(true);
		expect(result.removed).toBe(true);
		expect(result.reachedStage).toBe('removed');
		expect(h.events).toEqual(['upload', 'verify-head', 'commit', 'trash']);
	});

	// AC2 :: an upload failure rolls back - no pointer committed, original not
	// trashed. (spec section 10 O6)
	it('test_upload_failure_rolls_back', async () => {
		const backend = new MemoryBackend();
		backend.faults.put = () => {
			throw new Error('network down mid-upload');
		};
		const h = makeHarness(backend);
		const result = await offloadFile(file('books/x.pdf', 'data'), h.deps);
		expect(result.ok).toBe(false);
		expect(h.pointers.size).toBe(0);
		expect(h.trashed).toHaveLength(0);
	});

	// AC3 :: a verification failure keeps the original and commits no pointer.
	it('test_verify_failure_keeps_original', async () => {
		const backend = new MemoryBackend();
		const h = makeHarness(backend, {
			// a verifier that always reports a mismatch
			verify: () => Promise.resolve({ ok: false, tier: 'existence', remoteChecksum: null, reason: 'checksum mismatch' }),
		});
		const result = await offloadFile(file('books/x.pdf', 'data'), h.deps);
		expect(result.ok).toBe(false);
		expect(result.reachedStage).toBe('uploaded');
		expect(h.pointers.size).toBe(0);
		expect(h.trashed).toHaveLength(0);
	});

	// AC4 :: dead credentials during verify -> no HEAD -> no delete. The original
	// is never trashed. (spec section 10 worst-day)
	it('test_dead_creds_no_delete', async () => {
		const backend = new MemoryBackend();
		backend.faults.head = () => {
			throw new Error('AccessDenied: stale keys');
		};
		const h = makeHarness(backend);
		const result = await offloadFile(file('books/x.pdf', 'data'), h.deps);
		expect(result.ok).toBe(false);
		expect(h.trashed).toHaveLength(0);
		expect(h.pointers.size).toBe(0);
	});

	// AC5 :: a pre-existing truncated object at the key (a dropped PUT) is NOT
	// trusted; the pipeline re-uploads and the final object matches the full bytes.
	// (spec section 10 re-verify-on-resume)
	it('test_resume_reverifies_truncated', async () => {
		const backend = new MemoryBackend();
		const full = 'the complete intended payload of the document';
		const { key } = await previewKey(file('books/x.pdf', full), 'charles-main');
		await backend.seedObject(key, bytesOf('trunc')); // dropped PUT left a stub
		const h = makeHarness(backend);
		const result = await offloadFile(file('books/x.pdf', full), h.deps);
		expect(result.ok).toBe(true);
		const head = await backend.head(key);
		expect(head.checksumSha256).toBe(await sha256Base64(bytesOf(full)));
		expect(head.size).toBe(bytesOf(full).length);
	});

	// AC6 :: the committed pointer carries bucket info + identity, and the object
	// carries disaster-recovery metadata. (spec section 3)
	it('test_pointer_and_object_carry_identity', async () => {
		const backend = new MemoryBackend();
		const h = makeHarness(backend);
		const result = await offloadFile(file('books/Cranfield.pdf', 'romans'), h.deps);
		expect(result.record?.bucket).toBe('s3-dev-test');
		expect(result.record?.verificationTier).toBe('content');
		expect(result.record?.keyKind).toBe('hash');
		expect(result.record?.hash).not.toBeNull();
		const key = result.record?.key ?? '';
		const head = await backend.head(key);
		expect(head.metadata?.[OBJECT_METADATA_KEYS.sha256]).toBe(result.record?.hash);
		expect(head.metadata?.[OBJECT_METADATA_KEYS.originalPath]).toBe('books/Cranfield.pdf');
	});

	// AC7 :: the pointer note path is the original path plus ".md".
	it('test_pointer_path_is_md_sidecar', async () => {
		const backend = new MemoryBackend();
		const h = makeHarness(backend);
		const result = await offloadFile(file('books/Cranfield.pdf', 'x'), h.deps);
		expect(result.pointerPath).toBe('books/Cranfield.pdf.md');
	});
});

describe('offload pipeline property tests (la-p2-07)', () => {
	// prop_offload_restore_is_identity :: after offload, the bytes read back from
	// the StorageBackend equal the input (bytes through the backend, not markdown).
	it('prop_offload_restore_is_identity', async () => {
		await fc.assert(
			fc.asyncProperty(fc.uint8Array({ minLength: 1 }), async (data) => {
				const backend = new MemoryBackend();
				const h = makeHarness(backend);
				const result = await offloadFile({ path: 'data/blob.bin', bytes: data, contentType: 'application/octet-stream' }, h.deps);
				expect(result.ok).toBe(true);
				const key = result.record?.key ?? '';
				const restored = new Uint8Array(await (await backend.get(key)).arrayBuffer());
				expect(restored).toEqual(data);
			}),
			{ numRuns: 100 },
		);
	});
});

describe('offload pipeline failure injection (la-p2-07)', () => {
	// A commit (writePointer) failure after a passing verify keeps the original
	// (no data loss; the bytes are safely in the bucket, the space is just not
	// reclaimed yet).
	it('fault_commit_failure_keeps_original', async () => {
		const backend = new MemoryBackend();
		const h = makeHarness(backend, {
			writePointer: () => Promise.reject(new Error('disk full writing pointer')),
		});
		const result = await offloadFile(file('books/x.pdf', 'data'), h.deps);
		expect(result.ok).toBe(false);
		expect(result.reachedStage).toBe('verified');
		expect(h.trashed).toHaveLength(0);
	});

	// A trash failure after a committed, verified pointer is a non-fatal success:
	// the offload is logically done, the original simply remains.
	it('fault_trash_failure_is_nonfatal', async () => {
		const backend = new MemoryBackend();
		const h = makeHarness(backend, {
			trashOriginal: () => Promise.reject(new Error('file locked')),
		});
		const result = await offloadFile(file('books/x.pdf', 'data'), h.deps);
		expect(result.ok).toBe(true);
		expect(result.removed).toBe(false);
		expect(result.reachedStage).toBe('committed');
		expect(h.pointers.size).toBe(1);
	});

	// The default checksum verifier accepts a matching object and rejects a
	// size/checksum mismatch.
	it('fault_checksum_verifier_rejects_mismatch', async () => {
		const backend = new MemoryBackend();
		await backend.seedObject('k', bytesOf('the real bytes'));
		const good = await checksumVerifier(backend, 'k', {
			hash: 'unused',
			checksumBase64: await sha256Base64(bytesOf('the real bytes')),
			size: bytesOf('the real bytes').length,
		});
		expect(good.ok).toBe(true);
		expect(good.tier).toBe('content');
		const bad = await checksumVerifier(backend, 'k', { hash: 'unused', checksumBase64: 'WRONG', size: 999 });
		expect(bad.ok).toBe(false);
	});
});

describe('offload pipeline content-dedup (la-p5-26)', () => {
	// A shared-backend harness: two offloads against one backend + one events log,
	// so we can assert the second offload does NOT upload a second object.
	function sharedHarness(backend: StorageBackend, index: Map<string, { key: string; bucket: string; keyKind: 'hash' | 'external' }>) {
		const events: string[] = [];
		const pointers = new Map<string, string>();
		const trashed: string[] = [];
		const deps: OffloadDeps = {
			backend: logged(backend, events),
			bucket: 's3-dev-test',
			vaultPrefix: 'charles-main',
			writePointer: (p, c) => {
				events.push('commit');
				pointers.set(p, c);
				return Promise.resolve();
			},
			trashOriginal: (p) => {
				events.push('trash');
				trashed.push(p);
				return Promise.resolve();
			},
			newId: () => `ID-${pointers.size}`,
			now: () => '2026-06-18T00:00:00.000Z',
			findExistingByHash: (hash) => Promise.resolve(index.get(hash) ?? null),
		};
		return { deps, events, pointers, trashed };
	}

	// AC1 :: identical bytes at two different vault paths => ONE object, TWO
	// pointers. The second offload links to the existing object, no second upload.
	// (spec section 10 content-dedup; the goal's tier-0 acceptance case)
	it('test_dedup_links_existing_no_second_upload', async () => {
		const backend = new MemoryBackend();
		const index = new Map<string, { key: string; bucket: string; keyKind: 'hash' | 'external' }>();
		const bytes = 'the very same bytes under two different names';

		const h1 = sharedHarness(backend, index);
		const r1 = await offloadFile(file('books/Cranfield.pdf', bytes), h1.deps);
		expect(r1.ok).toBe(true);
		expect(r1.deduped).toBe(false);
		// register the first object so the second offload can find it
		if (r1.record?.hash) {
			index.set(r1.record.hash, { key: r1.record.key, bucket: r1.record.bucket, keyKind: r1.record.keyKind });
		}

		const h2 = sharedHarness(backend, index);
		const r2 = await offloadFile(file('inbox/copy-of-cranfield.pdf', bytes), h2.deps);
		expect(r2.ok).toBe(true);
		expect(r2.deduped).toBe(true);
		// the second pointer references the FIRST object's key
		expect(r2.record?.key).toBe(r1.record?.key);
		// ...but carries its OWN original path/name (restore must put it back right)
		expect(r2.record?.originalPath).toBe('inbox/copy-of-cranfield.pdf');
		expect(r2.record?.originalName).toBe('copy-of-cranfield.pdf');
		// the second offload uploaded nothing
		expect(h2.events).not.toContain('upload');

		// exactly one object in the bucket, referenced by two pointers
		const list = await backend.list('charles-main');
		expect(list.entries).toHaveLength(1);
	});

	// AC2 :: the dedup path verifies the EXISTING object before trashing the local
	// original (F1: a stale index never authorizes a delete). On a passing verify the
	// original is trashed.
	it('test_dedup_verifies_then_trashes', async () => {
		const backend = new MemoryBackend();
		const index = new Map<string, { key: string; bucket: string; keyKind: 'hash' | 'external' }>();
		const bytes = 'identical content';
		const h1 = sharedHarness(backend, index);
		const r1 = await offloadFile(file('a.pdf', bytes), h1.deps);
		index.set(r1.record!.hash!, { key: r1.record!.key, bucket: r1.record!.bucket, keyKind: r1.record!.keyKind });

		const h2 = sharedHarness(backend, index);
		const r2 = await offloadFile(file('b.pdf', bytes), h2.deps);
		expect(r2.deduped).toBe(true);
		expect(r2.removed).toBe(true);
		expect(h2.events).toContain('verify-head');
		expect(h2.trashed).toEqual(['b.pdf']);
	});

	// AC3 :: if the existing object has drifted (its bytes no longer match the hash),
	// dedup must NOT trust it - it falls through to a normal upload so the file is
	// still safely offloaded at its own key.
	it('test_dedup_drift_falls_through_to_upload', async () => {
		const backend = new MemoryBackend();
		const bytes = 'the real intended bytes';
		const { key: realKey } = await previewKey(file('a.pdf', bytes), 'charles-main');
		// the index points at a key whose object holds DIFFERENT bytes (drift)
		await backend.seedObject(realKey, bytesOf('totally different bytes'));
		const hash = await (await import('../hash/sha256')).sha256Hex(bytesOf(bytes));
		const index = new Map([[hash, { key: realKey, bucket: 's3-dev-test', keyKind: 'hash' as const }]]);

		const h = sharedHarness(backend, index);
		const result = await offloadFile(file('b.pdf', bytes), h.deps);
		expect(result.ok).toBe(true);
		expect(result.deduped).toBe(false); // did not link to the drifted object
		expect(h.events).toContain('upload'); // uploaded a fresh, correct copy
		const head = await backend.head(result.record!.key);
		expect(head.checksumSha256).toBe(await sha256Base64(bytesOf(bytes)));
	});

	// AC4 :: a stale index entry pointing at a deleted/missing object falls through
	// to a normal upload (the object is gone, so re-upload).
	it('test_dedup_missing_object_falls_through', async () => {
		const backend = new MemoryBackend();
		const bytes = 'content';
		const hash = await (await import('../hash/sha256')).sha256Hex(bytesOf(bytes));
		const index = new Map([[hash, { key: 'charles-main/ghost--000000.pdf', bucket: 's3-dev-test', keyKind: 'hash' as const }]]);
		const h = sharedHarness(backend, index);
		const result = await offloadFile(file('b.pdf', bytes), h.deps);
		expect(result.ok).toBe(true);
		expect(result.deduped).toBe(false);
		expect(h.events).toContain('upload');
	});

	// AC5 :: with no dedup lookup wired, behavior is exactly as before (always upload).
	it('test_no_dedup_dep_uploads_as_before', async () => {
		const backend = new MemoryBackend();
		const h = makeHarness(backend); // no findExistingByHash
		const result = await offloadFile(file('a.pdf', 'data'), h.deps);
		expect(result.ok).toBe(true);
		expect(result.deduped).toBe(false);
		expect(h.events).toEqual(['upload', 'verify-head', 'commit', 'trash']);
	});

	// prop :: offloading any bytes twice (at different paths, sharing a live index)
	// leaves exactly ONE object in the bucket.
	it('prop_offload_twice_one_object', async () => {
		await fc.assert(
			fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 64 }), async (data) => {
				const backend = new MemoryBackend();
				const index = new Map<string, { key: string; bucket: string; keyKind: 'hash' | 'external' }>();
				const h1 = sharedHarness(backend, index);
				const r1 = await offloadFile({ path: 'one/blob.bin', bytes: data, contentType: 'application/octet-stream' }, h1.deps);
				index.set(r1.record!.hash!, { key: r1.record!.key, bucket: r1.record!.bucket, keyKind: r1.record!.keyKind });
				const h2 = sharedHarness(backend, index);
				const r2 = await offloadFile({ path: 'two/blob.bin', bytes: data, contentType: 'application/octet-stream' }, h2.deps);
				expect(r2.deduped).toBe(true);
				const list = await backend.list('');
				expect(list.entries).toHaveLength(1);
			}),
			{ numRuns: 50 },
		);
	});
});

// Derive the key the pipeline will assign, to seed a colliding object for the
// resume test. Mirrors the pipeline's own derivation.
async function previewKey(f: OffloadFile, vaultPrefix: string): Promise<{ key: string }> {
	const { layoutHashKey } = await import('../key/layout');
	const { sha256Hex } = await import('../hash/sha256');
	const hash = await sha256Hex(f.bytes);
	return { key: layoutHashKey({ vaultPrefix, originalPath: f.path, hash }).key };
}
