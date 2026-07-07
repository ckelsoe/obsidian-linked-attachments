import fc from 'fast-check';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { LocalBackend, resolveLocalRoot } from './local-backend';
import { BackendError, ObjectNotFoundError } from './backend';
import { sha256Base64, sha256Hex } from '../hash/sha256';
import { verifyByLadder } from '../offload/verify';

// Tier 0-ish: LocalBackend is exercised against a fresh OS temp directory per
// test (spec section 8 allows "MemoryBackend + temp dirs + fixture vaults"). No
// network, no shared mutable fixtures - each test mints its own root and every
// root is removed in afterAll (development-plan section 6 DoD).

const roots: string[] = [];

async function makeBackend(): Promise<{ backend: LocalBackend; root: string }> {
	const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'la-local-'));
	roots.push(root);
	return { backend: new LocalBackend(root), root };
}

afterAll(async () => {
	for (const root of roots) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			total += value.length;
		}
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

describe('LocalBackend acceptance', () => {
	// put then get round-trips byte-equal at status 200, and the nested key created
	// the mirroring directories on disk (preserve-structure spine).
	it('test_put_then_get_roundtrip', async () => {
		const { backend, root } = await makeBackend();
		const body = bytes('hello world');
		await backend.put('books/romans/a.pdf', body, body.length);
		const got = await backend.get('books/romans/a.pdf');
		expect(got.status).toBe(200);
		expect(await readAll(got.stream())).toEqual(body);
		expect(new Uint8Array(await got.arrayBuffer())).toEqual(body);
		// The bytes really landed at the mirrored path under the root.
		const onDisk = await fs.readFile(nodePath.join(root, 'books', 'romans', 'a.pdf'));
		expect(new Uint8Array(onDisk)).toEqual(body);
	});

	// head reports the real byte size and a non-empty change-detection etag.
	it('test_head_reports_size_etag', async () => {
		const { backend } = await makeBackend();
		const body = bytes('twelve bytes');
		await backend.put('k', body, body.length);
		const head = await backend.head('k');
		expect(head.size).toBe(body.length);
		expect(head.etag.length).toBeGreaterThan(0);
		expect(head.metadata).toEqual({});
	});

	// a range GET returns 206 with only the requested bytes and the contentRange.
	it('test_get_range_returns_206', async () => {
		const { backend } = await makeBackend();
		const body = bytes('0123456789');
		await backend.put('k', body, body.length);
		const got = await backend.get('k', { start: 2, end: 5 });
		expect(got.status).toBe(206);
		expect(got.contentRange).toBe('bytes 2-5/10');
		expect(await readAll(got.stream())).toEqual(bytes('2345'));
	});

	// an out-of-range or reversed range yields an empty, well-formed 206 - never a
	// malformed `bytes 0--1/0` or a backwards range.
	it('test_get_range_out_of_bounds_is_wellformed', async () => {
		const { backend } = await makeBackend();
		const body = bytes('0123456789');
		await backend.put('k', body, body.length);
		const beyond = await backend.get('k', { start: 20, end: 30 });
		expect(beyond.status).toBe(206);
		expect(beyond.contentRange).toBe('bytes 10-10/10');
		expect(new Uint8Array(await beyond.arrayBuffer()).length).toBe(0);

		await backend.put('empty', new Uint8Array(0), 0);
		const emptyRange = await backend.get('empty', { start: 0, end: 0 });
		expect(emptyRange.contentRange).toBe('bytes 0-0/0');
		expect(new Uint8Array(await emptyRange.arrayBuffer()).length).toBe(0);
	});

	// delete removes the object; a later head/get raises ObjectNotFoundError; and
	// the now-empty mirrored directories are pruned so no skeleton is left behind.
	it('test_delete_removes_object_and_prunes_dirs', async () => {
		const { backend, root } = await makeBackend();
		const body = bytes('x');
		await backend.put('deep/nested/k.bin', body, body.length);
		await backend.delete('deep/nested/k.bin');
		await expect(backend.head('deep/nested/k.bin')).rejects.toBeInstanceOf(ObjectNotFoundError);
		await expect(backend.get('deep/nested/k.bin')).rejects.toBeInstanceOf(ObjectNotFoundError);
		await expect(fs.access(nodePath.join(root, 'deep'))).rejects.toBeDefined();
		// The root itself is never pruned.
		await expect(fs.access(root)).resolves.toBeUndefined();
	});

	// delete of a missing key is idempotent (S3 DELETE semantics), never throws.
	it('test_delete_missing_is_idempotent', async () => {
		const { backend } = await makeBackend();
		await expect(backend.delete('never/existed')).resolves.toBeUndefined();
	});

	// list under a prefix pages through with maxKeys, returning every key exactly
	// once across pages via the continuation cursor; keys are forward-slash and
	// relative to the root, and objects outside the prefix are excluded.
	it('test_list_prefix_pagination', async () => {
		const { backend } = await makeBackend();
		for (const name of ['p/a', 'p/b', 'p/c', 'other/d']) {
			await backend.put(name, bytes(name), name.length);
		}
		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const page = await backend.list('p/', { maxKeys: 2, cursor: cursor ?? undefined });
			seen.push(...page.entries.map((e) => e.key));
			cursor = page.cursor;
		} while (cursor !== null);
		expect(seen.sort()).toEqual(['p/a', 'p/b', 'p/c']);
	});

	// if the cursor key is deleted between pages, the next page still returns the
	// remaining keys (resume from first key > cursor), never silently drops them.
	it('test_list_resumes_after_deleted_cursor', async () => {
		const { backend } = await makeBackend();
		for (const name of ['p/a', 'p/b', 'p/c']) {
			await backend.put(name, bytes(name), name.length);
		}
		const first = await backend.list('p/', { maxKeys: 2 });
		expect(first.entries.map((e) => e.key)).toEqual(['p/a', 'p/b']);
		expect(first.cursor).toBe('p/b');
		// The cursor key vanishes before the next page is fetched.
		await backend.delete('p/b');
		const second = await backend.list('p/', { maxKeys: 2, cursor: first.cursor ?? undefined });
		expect(second.entries.map((e) => e.key)).toEqual(['p/c']);
	});

	// a non-positive maxKeys does not produce an un-paginable page (truncated with a
	// null cursor); it falls back to the default page size.
	it('test_list_zero_maxkeys_does_not_break_pagination', async () => {
		const { backend } = await makeBackend();
		await backend.put('p/a', bytes('a'), 1);
		const page = await backend.list('p/', { maxKeys: 0 });
		expect(page.entries.map((e) => e.key)).toEqual(['p/a']);
		expect(page.isTruncated).toBe(false);
		expect(page.cursor).toBeNull();
	});

	// list with a delimiter groups keys into folder-like commonPrefixes, exactly
	// like the S3 / Memory backends (the reconcile scanner depends on one behavior).
	it('test_list_delimiter_groups_prefixes', async () => {
		const { backend } = await makeBackend();
		for (const name of ['books/a.pdf', 'books/b.pdf', 'audio/c.mp3', 'top.txt']) {
			await backend.put(name, bytes(name), name.length);
		}
		const page = await backend.list('', { delimiter: '/' });
		expect(page.commonPrefixes.sort()).toEqual(['audio/', 'books/']);
		expect(page.entries.map((e) => e.key)).toEqual(['top.txt']);
	});

	// the backend advertises the local capability shape and returns a filesystem
	// path as its display key (the access-axis payoff, spec section 3).
	it('test_capabilities_local_axis', async () => {
		const { backend, root } = await makeBackend();
		expect(backend.capabilities.upload.presign).toBe(false);
		expect(backend.capabilities.upload.serverChecksum).toBe(false);
		expect(backend.capabilities.upload.conditionalWrite).toBe(false);
		expect(backend.capabilities.upload.range).toBe(true);
		expect(backend.capabilities.access).toBe('local-path');
		expect(backend.displayKey('folder/file--9f86d0.pdf')).toBe(nodePath.join(root, 'folder', 'file--9f86d0.pdf'));
	});

	// a serverChecksum-false backend returns no checksum on PUT/GET; the caller's
	// checksum hint is simply not honoured server-side (the ladder rehashes).
	it('test_no_server_checksum', async () => {
		const { backend } = await makeBackend();
		const body = bytes('verify me');
		const result = await backend.put('k', body, body.length, { checksumSha256: await sha256Base64(body) });
		expect(result.checksumSha256).toBeUndefined();
		expect((await backend.get('k')).checksumSha256).toBeUndefined();
		expect((await backend.head('k')).checksumSha256).toBeUndefined();
	});
});

describe('resolveLocalRoot', () => {
	// A path with surrounding quotes (a common "Copy as path" paste) resolves the
	// same as the bare path: the value goes to fs, never a shell, so quotes would
	// otherwise become a literal part of the path. Spaces need no quoting.
	it('test_strips_surrounding_quotes', () => {
		const bare = 'a/b c/la-test';
		expect(resolveLocalRoot(`"${bare}"`)).toBe(resolveLocalRoot(bare));
		expect(resolveLocalRoot(`'${bare}'`)).toBe(resolveLocalRoot(bare));
	});

	// A blank or whitespace-only root resolves to '' (the caller reads that as "not
	// configured"), never the current working directory.
	it('test_blank_root_is_empty', () => {
		expect(resolveLocalRoot('')).toBe('');
		expect(resolveLocalRoot('   ')).toBe('');
	});

	// A delimited env var that does not resolve on this machine must fail closed to
	// '' (read as "not configured here"), never a cwd-relative path that a later
	// offload would write verified bytes into.
	it('test_unresolved_env_var_fails_closed', () => {
		const missing = 'LA_DEFINITELY_UNSET_VAR_9137';
		delete process.env[missing];
		expect(resolveLocalRoot(`%${missing}%\\sub`)).toBe('');
		expect(resolveLocalRoot(`\${${missing}}/sub`)).toBe('');
		// Bare $VAR form too: expandEnv leaves it in place, so it must fail closed
		// rather than become a cwd-relative path.
		expect(resolveLocalRoot(`$${missing}/sub`)).toBe('');
	});
});

describe('LocalBackend safety', () => {
	// a key with a traversal segment is rejected rather than escaping the root - a
	// key the plugin did not mint must never write outside the offload folder.
	it('test_traversal_key_rejected', async () => {
		const { backend } = await makeBackend();
		const body = bytes('x');
		await expect(backend.put('../escape.txt', body, body.length)).rejects.toBeInstanceOf(BackendError);
		await expect(backend.get('a/../../etc/passwd')).rejects.toBeInstanceOf(BackendError);
	});

	// a declared size that disagrees with the body is rejected and nothing is
	// written, so the O6 rollback starts from a clean slate.
	it('test_size_mismatch_rejected', async () => {
		const { backend } = await makeBackend();
		const body = bytes('four');
		await expect(backend.put('k', body, 999)).rejects.toBeInstanceOf(BackendError);
		await expect(backend.head('k')).rejects.toBeInstanceOf(ObjectNotFoundError);
	});

	// a backslash in a key is rejected: on Windows it would alias with the
	// forward-slash form (a\b vs a/b -> same file) and could smuggle a traversal.
	it('test_backslash_key_rejected', async () => {
		const { backend } = await makeBackend();
		const body = bytes('x');
		await expect(backend.put('a\\b.txt', body, body.length)).rejects.toBeInstanceOf(BackendError);
	});

	// a key that maps to a prefix directory is not an object: head/get report
	// not-found and delete is a no-op, never a raw EISDIR/EPERM.
	it('test_directory_key_is_not_an_object', async () => {
		const { backend } = await makeBackend();
		const body = bytes('x');
		await backend.put('a/b.bin', body, body.length);
		await expect(backend.head('a')).rejects.toBeInstanceOf(ObjectNotFoundError);
		await expect(backend.get('a')).rejects.toBeInstanceOf(ObjectNotFoundError);
		await expect(backend.delete('a')).resolves.toBeUndefined();
		// The real object is untouched by the no-op directory delete.
		expect((await backend.head('a/b.bin')).size).toBe(body.length);
	});

	// on Windows, a key that resolves past the 260-char MAX_PATH is refused up front
	// with a clear error, so the offload fails cleanly (original kept) instead of a
	// cryptic fs failure. Skipped off Windows, where the limit does not apply.
	const winIt = process.platform === 'win32' ? it : it.skip;
	winIt('test_windows_maxpath_rejected', async () => {
		const { backend } = await makeBackend();
		const longKey = `${'a'.repeat(230)}.bin`;
		const body = bytes('x');
		await expect(backend.put(longKey, body, body.length)).rejects.toBeInstanceOf(BackendError);
	});

	// a completed put leaves no .la-tmp write-temp behind, and such temps are never
	// surfaced by list even if one lingers from an interrupted write.
	it('test_atomic_write_leaves_no_temp', async () => {
		const { backend, root } = await makeBackend();
		const body = bytes('payload');
		await backend.put('dir/k.bin', body, body.length);
		const entries = await fs.readdir(nodePath.join(root, 'dir'));
		expect(entries).toEqual(['k.bin']);
		// A lingering temp from a crashed write is not an object.
		await fs.writeFile(nodePath.join(root, 'dir', 'k.bin.la-tmp-99'), 'junk');
		const page = await backend.list('dir/');
		expect(page.entries.map((e) => e.key)).toEqual(['dir/k.bin']);
	});
});

describe('LocalBackend verify-ladder integration', () => {
	// The whole point of the seam: with no server checksum, verify.ts lands on rung
	// 3 (GET + rehash) and still reports an honest `content` tier for a local file,
	// so offload's delete gate clears legitimately (spec section 10 F1).
	it('test_get_rehash_yields_content_tier', async () => {
		const { backend } = await makeBackend();
		const body = bytes('the complete intended payload');
		await backend.put('k', body, body.length);
		const result = await verifyByLadder(backend, 'k', {
			hash: await sha256Hex(body),
			checksumBase64: await sha256Base64(body),
			size: body.length,
		});
		expect(result.tier).toBe('content');
	});

	// A drifted object (different bytes at the key) is NOT content-verified: the
	// ladder reports existence, so the delete gate refuses (never a false delete).
	it('test_drifted_bytes_not_content_verified', async () => {
		const { backend, root } = await makeBackend();
		const intended = bytes('the intended payload');
		await backend.put('k', intended, intended.length);
		// Simulate an external overwrite with different, same-length-ish bytes.
		await fs.writeFile(nodePath.join(root, 'k'), 'a totally different payload!');
		const result = await verifyByLadder(backend, 'k', {
			hash: await sha256Hex(intended),
			checksumBase64: await sha256Base64(intended),
			size: intended.length,
		});
		expect(result.tier).not.toBe('content');
	});
});

describe('LocalBackend property tests', () => {
	// for any bytes, get(put(bytes)) == bytes. The backend invariant offload's
	// restore-is-identity builds on.
	it('prop_put_get_roundtrip_identity', async () => {
		const { backend } = await makeBackend();
		let counter = 0;
		await fc.assert(
			fc.asyncProperty(fc.uint8Array(), async (data) => {
				const key = `p/obj-${counter++}`;
				await backend.put(key, data, data.length);
				const got = await backend.get(key);
				expect(new Uint8Array(await got.arrayBuffer())).toEqual(data);
			}),
			{ numRuns: 100 },
		);
	});

	// paging with a small maxKeys returns exactly the put keys, no duplicates, no
	// omissions - the same pagination guarantee the Memory/S3 backends give.
	it('prop_list_returns_all_keys_once', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.uniqueArray(fc.stringMatching(/^[a-z0-9]{1,8}$/), { minLength: 0, maxLength: 20 }),
				fc.integer({ min: 1, max: 5 }),
				async (names, pageSize) => {
					const { backend } = await makeBackend();
					for (const name of names) {
						await backend.put(`pre/${name}`, bytes(name), name.length);
					}
					const seen: string[] = [];
					let cursor: string | null = null;
					do {
						const page = await backend.list('pre/', { maxKeys: pageSize, cursor: cursor ?? undefined });
						seen.push(...page.entries.map((e) => e.key));
						cursor = page.cursor;
					} while (cursor !== null);
					expect(seen.sort()).toEqual(names.map((n) => `pre/${n}`).sort());
				},
			),
			{ numRuns: 40 },
		);
	});
});
