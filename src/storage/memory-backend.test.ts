import fc from 'fast-check';
import { MemoryBackend } from './memory-backend';
import { BackendError, ObjectNotFoundError } from './backend';
import { sha256Base64 } from '../hash/sha256';

// Tier 0: every test builds its own MemoryBackend instance. No shared mutable
// fixtures, no network, no module-level state (development-plan section 6 DoD).

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

describe('MemoryBackend acceptance (la-p1-01)', () => {
	// AC1 :: put then get round-trips byte-equal at status 200. (spec section 7.1)
	it('test_put_then_get_roundtrip', async () => {
		const backend = new MemoryBackend();
		const body = bytes('hello world');
		await backend.put('a/b.txt', body, body.length);
		const got = await backend.get('a/b.txt');
		expect(got.status).toBe(200);
		expect(await readAll(got.stream())).toEqual(body);
		expect(new Uint8Array(await got.arrayBuffer())).toEqual(body);
	});

	// AC2 :: head reports the stored size and a non-empty etag. (charter head shape)
	it('test_head_reports_size_etag', async () => {
		const backend = new MemoryBackend();
		const body = bytes('twelve bytes');
		await backend.put('k', body, body.length);
		const head = await backend.head('k');
		expect(head.size).toBe(body.length);
		expect(head.etag.length).toBeGreaterThan(0);
	});

	// AC3 :: a range GET returns 206 with only the requested bytes and contentRange.
	// (charter GetResult status 200|206)
	it('test_get_range_returns_206', async () => {
		const backend = new MemoryBackend();
		const body = bytes('0123456789');
		await backend.put('k', body, body.length);
		const got = await backend.get('k', { start: 2, end: 5 });
		expect(got.status).toBe(206);
		expect(got.contentRange).toBe('bytes 2-5/10');
		expect(await readAll(got.stream())).toEqual(bytes('2345'));
	});

	// AC4 :: delete removes the object; a later head/get raises ObjectNotFoundError.
	it('test_delete_removes_object', async () => {
		const backend = new MemoryBackend();
		const body = bytes('x');
		await backend.put('k', body, body.length);
		await backend.delete('k');
		await expect(backend.head('k')).rejects.toBeInstanceOf(ObjectNotFoundError);
		await expect(backend.get('k')).rejects.toBeInstanceOf(ObjectNotFoundError);
	});

	// AC5 :: list under a prefix pages through with maxKeys, returning every key
	// exactly once across pages via the continuation cursor. (AC-G3 readable keys
	// + pagination; spec section 6 scanner depends on list)
	it('test_list_prefix_pagination', async () => {
		const backend = new MemoryBackend();
		for (const name of ['p/a', 'p/b', 'p/c', 'other/d']) {
			await backend.put(name, bytes(name), name.length);
		}
		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const page: Awaited<ReturnType<MemoryBackend['list']>> = await backend.list('p/', {
				maxKeys: 2,
				cursor: cursor ?? undefined,
			});
			seen.push(...page.entries.map((e) => e.key));
			cursor = page.cursor;
		} while (cursor !== null);
		expect(seen.sort()).toEqual(['p/a', 'p/b', 'p/c']);
	});

	// AC6 :: the backend exposes both capability axes and a browsable display key.
	// (spec section 3 two-axis capability flags + native display key)
	it('test_capabilities_two_axes', () => {
		const backend = new MemoryBackend();
		expect(typeof backend.capabilities.upload.presign).toBe('boolean');
		expect(typeof backend.capabilities.upload.range).toBe('boolean');
		expect(typeof backend.capabilities.upload.serverChecksum).toBe('boolean');
		expect(typeof backend.capabilities.upload.conditionalWrite).toBe('boolean');
		expect(['presigned-url', 'local-path', 'native-app']).toContain(backend.capabilities.access);
		expect(backend.displayKey('folder/file--9f86d0.pdf')).toBe('folder/file--9f86d0.pdf');
	});

	// AC7 :: with serverChecksum, a matching checksummed PUT succeeds and head
	// returns the sha256; a mismatching checksum is rejected (server validates the
	// received bytes - spec section 10 F1 rung 1, the safety-critical seam).
	it('test_checksummed_put_validates', async () => {
		const backend = new MemoryBackend();
		const body = bytes('verify me');
		const checksum = await sha256Base64(body);
		const result = await backend.put('ok', body, body.length, { checksumSha256: checksum });
		expect(result.checksumSha256).toBe(checksum);
		expect((await backend.head('ok')).checksumSha256).toBe(checksum);

		await expect(
			backend.put('bad', body, body.length, { checksumSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
		).rejects.toMatchObject({ kind: 'checksum-mismatch' });
		await expect(backend.head('bad')).rejects.toBeInstanceOf(ObjectNotFoundError);
	});

	// AC8 :: object metadata written on PUT is returned by HEAD (disaster-recovery
	// spine, spec section 3).
	it('test_metadata_roundtrip', async () => {
		const backend = new MemoryBackend();
		const body = bytes('m');
		const metadata = { sha256: 'deadbeef', originalpath: 'books/x.pdf' };
		await backend.put('k', body, body.length, { metadata });
		expect((await backend.head('k')).metadata).toEqual(metadata);
	});
});

describe('MemoryBackend property tests (la-p1-01)', () => {
	// prop_put_get_roundtrip_identity :: for any bytes, get(put(bytes)) == bytes.
	// The fundamental backend invariant that prop_offload_restore_is_identity
	// (la-p2-07) builds on.
	it('prop_put_get_roundtrip_identity', async () => {
		await fc.assert(
			fc.asyncProperty(fc.uint8Array(), async (data) => {
				const backend = new MemoryBackend();
				await backend.put('k', data, data.length);
				const got = await backend.get('k');
				const round = new Uint8Array(await got.arrayBuffer());
				expect(round).toEqual(data);
			}),
			{ numRuns: 200 },
		);
	});

	// prop_list_returns_all_keys_once :: paging with a small maxKeys returns
	// exactly the put keys, no duplicates, no omissions (pagination correctness).
	it('prop_list_returns_all_keys_once', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.uniqueArray(fc.stringMatching(/^[a-z0-9]{1,8}$/), { minLength: 0, maxLength: 25 }),
				fc.integer({ min: 1, max: 5 }),
				async (names, pageSize) => {
					const backend = new MemoryBackend();
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
			{ numRuns: 100 },
		);
	});
});

describe('MemoryBackend failure injection (la-p1-01)', () => {
	// A missing object is a typed not-found, never an undefined that a caller
	// might mistake for success.
	it('fault_get_missing_is_typed_not_found', async () => {
		const backend = new MemoryBackend();
		await expect(backend.get('nope')).rejects.toBeInstanceOf(ObjectNotFoundError);
		await expect(backend.head('nope')).rejects.toBeInstanceOf(ObjectNotFoundError);
	});

	// An injected PUT fault rejects and stores nothing (the op is atomic, so the
	// offload pipeline's O6 rollback has a clean slate).
	it('fault_put_hook_throws_stores_nothing', async () => {
		const backend = new MemoryBackend();
		backend.faults.put = () => {
			throw new BackendError('network', 'injected put failure');
		};
		const body = bytes('data');
		await expect(backend.put('k', body, body.length)).rejects.toBeInstanceOf(BackendError);
		delete backend.faults.put;
		await expect(backend.head('k')).rejects.toBeInstanceOf(ObjectNotFoundError);
	});

	// An injected HEAD fault (dead creds) rejects without mutating the object:
	// the bytes survive, so "no HEAD -> no delete" cannot lose data (spec
	// section 10 worst-day).
	it('fault_head_hook_throws_leaves_object_intact', async () => {
		const backend = new MemoryBackend();
		const body = bytes('safe');
		await backend.put('k', body, body.length);
		backend.faults.head = () => {
			throw new BackendError('auth', 'dead creds');
		};
		await expect(backend.head('k')).rejects.toMatchObject({ kind: 'auth' });
		delete backend.faults.head;
		expect(new Uint8Array(await (await backend.get('k')).arrayBuffer())).toEqual(body);
	});

	// A seeded truncated object (a dropped PUT that reused the content-hash key)
	// reports a checksum that differs from the full-file expected checksum, so
	// re-verify-on-resume can detect it instead of assuming-done (spec section 10
	// path 10 / re-verify-on-resume).
	it('fault_truncated_seed_detected_by_checksum', async () => {
		const backend = new MemoryBackend();
		const full = bytes('the complete intended payload');
		const truncated = full.slice(0, 5);
		const expected = await sha256Base64(full);
		await backend.seedObject('k', truncated);
		const head = await backend.head('k');
		expect(head.checksumSha256).not.toBe(expected);
		expect(head.size).toBe(truncated.length);
	});
});
