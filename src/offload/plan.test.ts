import fc from 'fast-check';
import { planOffload, formatBytes } from './plan';
import { layoutHashKey } from '../key/layout';
import { sha256Hex } from '../hash/sha256';
import { offloadFile, OffloadDeps } from './pipeline';
import { MemoryBackend } from '../storage/memory-backend';
import { decodePointer, requireS3Backend } from '../pointer/codec';

// B7 dry-run preview (development-plan section 8, v1 onboarding floor). planOffload
// computes exactly what an offload WOULD do without performing it: it takes no
// backend and no vault side-effect deps, so "nothing moved" is structural, not a
// promise. The preview is honest only if its key/pointerPath match what the
// pipeline actually produces - test_plan_matches_pipeline locks that.

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('planOffload', () => {
	const config = { vaultPrefix: 'charles-main', bucket: 'my-bucket' };

	it('AC1 test_plan_mirrors_key :: key is the readable vault mirror + hash suffix', async () => {
		const input = { path: '31-books/Romans/Cranfield.pdf', bytes: bytes('content'), contentType: 'application/pdf' };
		const plan = await planOffload(input, config);
		const hash = await sha256Hex(input.bytes);
		expect(plan.key).toBe(layoutHashKey({ vaultPrefix: 'charles-main', originalPath: input.path, hash }).key);
		expect(plan.bucket).toBe('my-bucket');
		expect(plan.keyKind).toBe('hash');
	});

	it('AC2 test_plan_pointer_path_is_md_sidecar :: pointer path is the file + .md', async () => {
		const plan = await planOffload({ path: 'a/b/file.epub', bytes: bytes('x'), contentType: 'application/epub+zip' }, config);
		expect(plan.pointerPath).toBe('a/b/file.epub.md');
		expect(plan.originalName).toBe('file.epub');
		expect(plan.byteSize).toBe(1);
		expect(plan.contentType).toBe('application/epub+zip');
	});

	it('AC3 test_plan_multidot_ext :: ext is after the last dot', async () => {
		const plan = await planOffload({ path: 'data/archive.tar.gz', bytes: bytes('z'), contentType: 'application/gzip' }, config);
		expect(plan.originalExt).toBe('gz');
	});

	it('AC4 test_plan_matches_pipeline :: the preview equals what offload commits', async () => {
		const input = { path: 'books/Deep Work.pdf', bytes: bytes('the real bytes'), contentType: 'application/pdf' };
		const plan = await planOffload(input, config);

		const backend = new MemoryBackend();
		let committed = '';
		const deps: OffloadDeps = {
			targets: [{ backend, toRef: (key) => ({ type: 's3', bucket: 'my-bucket', key, keyKind: 'hash' }) }],
			bucket: 'my-bucket',
			vaultPrefix: 'charles-main',
			writePointer: (_path, content) => { committed = content; return Promise.resolve(); },
			trashOriginal: () => Promise.resolve(),
			newId: () => 'id-1',
			now: () => '2026-06-17T00:00:00.000Z',
		};
		const result = await offloadFile(input, deps);
		expect(result.ok).toBe(true);
		expect(result.record && requireS3Backend(result.record).key).toBe(plan.key);
		expect(result.pointerPath).toBe(plan.pointerPath);
		expect(result.record?.hash).toBe(plan.hash);
		// the actually-committed pointer carries the previewed key (no surprise)
		expect(requireS3Backend(decodePointer(committed).record).key).toBe(plan.key);
	});

	it('prop_plan_deterministic :: same inputs produce an identical plan', async () => {
		await fc.assert(
			fc.asyncProperty(fc.string(), fc.string({ minLength: 1 }), async (body, name) => {
				const input = { path: `f/${name}.bin`, bytes: bytes(body), contentType: 'application/octet-stream' };
				const a = await planOffload(input, config);
				const b = await planOffload(input, config);
				expect(a).toEqual(b);
			}),
			{ numRuns: 30 },
		);
	});
});

describe('formatBytes', () => {
	it('renders human-readable sizes for the preview', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
		expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
	});
});
