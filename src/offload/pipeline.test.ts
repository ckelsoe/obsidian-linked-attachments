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

// Derive the key the pipeline will assign, to seed a colliding object for the
// resume test. Mirrors the pipeline's own derivation.
async function previewKey(f: OffloadFile, vaultPrefix: string): Promise<{ key: string }> {
	const { layoutHashKey } = await import('../key/layout');
	const { sha256Hex } = await import('../hash/sha256');
	const hash = await sha256Hex(f.bytes);
	return { key: layoutHashKey({ vaultPrefix, originalPath: f.path, hash }).key };
}
