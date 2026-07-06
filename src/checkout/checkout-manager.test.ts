import { CheckoutManager, CheckoutDeps } from './checkout-manager';
import { workingCopyPath } from './checkout-state';
import { MemoryBackend } from '../storage/memory-backend';
import { OBJECT_METADATA_KEYS } from '../manifest/manifest';
import { encodePointer, decodePointer, PointerRecord, requireS3Backend } from '../pointer/codec';
import { sha256Hex, sha256Base64 } from '../hash/sha256';

// Tier 0: the checkout-manager runs against MemoryBackend with injected vault I/O
// (pointer read/write, working-copy read/write, open-in-app, conflict-copy write).
// No filesystem, no Obsidian. The native-app open and the real vault adapter are the
// parked runtime (la-p6-33); the lifecycle + safety logic is all proven here.

function bytesOf(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function record(overrides: Partial<PointerRecord> = {}): PointerRecord {
	return {
		laVersion: 1,
		id: 'ptr-1',
		hash: 'PLACEHOLDER',
		backends: [
			{
				type: 's3',
				bucket: 's3-dev-test',
				key: 'charles-main/budget--aaaaaa.xlsx',
				keyKind: 'hash',
			},
		],
		originalName: 'budget.xlsx',
		originalExt: 'xlsx',
		originalPath: 'finance/budget.xlsx',
		byteSize: 0,
		contentType: 'application/octet-stream',
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

interface Harness {
	deps: CheckoutDeps;
	backend: MemoryBackend;
	pointers: Map<string, string>;
	working: Map<string, Uint8Array>;
	conflicts: Map<string, Uint8Array>;
	opened: string[];
}

function makeHarness(host = 'mbp'): Harness {
	const backend = new MemoryBackend();
	const pointers = new Map<string, string>();
	const working = new Map<string, Uint8Array>();
	const conflicts = new Map<string, Uint8Array>();
	const opened: string[] = [];
	const deps: CheckoutDeps = {
		backend,
		vaultPrefix: 'charles-main',
		readPointer: (p) => {
			const t = pointers.get(p);
			if (t === undefined) {
				return Promise.reject(new Error(`no pointer at ${p}`));
			}
			return Promise.resolve(t);
		},
		writePointer: (p, t) => {
			pointers.set(p, t);
			return Promise.resolve();
		},
		writeWorkingCopy: (p, b) => {
			working.set(p, b);
			return Promise.resolve();
		},
		readWorkingCopy: (p) => {
			const b = working.get(p);
			if (b === undefined) {
				return Promise.reject(new Error(`no working copy at ${p}`));
			}
			return Promise.resolve(b);
		},
		removeWorkingCopy: (p) => {
			working.delete(p);
			return Promise.resolve();
		},
		workingCopyExists: (p) => Promise.resolve(working.has(p)),
		openInDefaultApp: (p) => {
			opened.push(p);
			return Promise.resolve();
		},
		writeConflictCopy: (p, b) => {
			conflicts.set(p, b);
			return Promise.resolve();
		},
		host: () => host,
		now: () => '2026-06-18T12:00:00.000Z',
	};
	return { deps, backend, pointers, working, conflicts, opened };
}

// Seed an offloaded object + its pointer note, returning the pointer path + record.
async function seedOffloaded(h: Harness, content: string): Promise<{ pointerPath: string; rec: PointerRecord }> {
	const bytes = bytesOf(content);
	const hash = await sha256Hex(bytes);
	const rec = record({ hash, byteSize: bytes.length });
	await h.backend.put(requireS3Backend(rec).key, bytes, bytes.length, {
		checksumSha256: await sha256Base64(bytes),
		metadata: { [OBJECT_METADATA_KEYS.sha256]: hash },
	});
	const pointerPath = `${rec.originalPath}.md`;
	h.pointers.set(pointerPath, encodePointer(rec, 'User notes.\n'));
	return { pointerPath, rec };
}

describe('checkout (la-p6-32)', () => {
	it('test_checkout_writes_working_copy_and_opens', async () => {
		const h = makeHarness();
		const { pointerPath, rec } = await seedOffloaded(h, 'budget v1 contents');
		const manager = new CheckoutManager(h.deps);
		const result = await manager.checkout(pointerPath);
		expect(result.ok).toBe(true);
		const wcPath = workingCopyPath(rec.hash as string, rec.originalName);
		expect(h.working.has(wcPath)).toBe(true);
		expect(new TextDecoder().decode(h.working.get(wcPath))).toBe('budget v1 contents');
		expect(h.opened).toEqual([wcPath]);
		// the pointer is now checked out (markers set), still the visible anchor
		expect(decodePointer(h.pointers.get(pointerPath) as string).record.copyState).toBe('checked-out');
	});

	// F1 in reverse: never open drifted bytes - verify the GET against the recorded hash.
	it('test_checkout_refuses_drifted_bytes', async () => {
		const h = makeHarness();
		const { pointerPath, rec } = await seedOffloaded(h, 'budget v1 contents');
		await h.backend.seedObject(requireS3Backend(rec).key, bytesOf('tampered different bytes')); // drift
		const manager = new CheckoutManager(h.deps);
		const result = await manager.checkout(pointerPath);
		expect(result.ok).toBe(false);
		expect(h.working.size).toBe(0);
		expect(decodePointer(h.pointers.get(pointerPath) as string).record.copyState).toBe('offloaded');
	});

	// Advisory lock: another host holds it -> refuse without force; force overrides.
	it('test_checkout_refuses_held_by_other_unless_forced', async () => {
		const h = makeHarness('mbp');
		const { pointerPath } = await seedOffloaded(h, 'shared doc');
		// simulate another device's checkout by writing its markers onto the shared
		// pointer (same maps + backend, a different host).
		const otherManager = new CheckoutManager({ ...h.deps, host: () => 'work-pc' });
		await otherManager.checkout(pointerPath);
		// now THIS device (mbp) tries
		const manager = new CheckoutManager(h.deps);
		const refused = await manager.checkout(pointerPath);
		expect(refused.ok).toBe(false);
		expect(refused.lockState).toBe('held-by-other');
		const forced = await manager.checkout(pointerPath, { force: true });
		expect(forced.ok).toBe(true);
	});
});

describe('check-in (la-p6-32)', () => {
	it('test_checkin_noop_when_unchanged', async () => {
		const h = makeHarness();
		const { pointerPath, rec } = await seedOffloaded(h, 'unchanged');
		const manager = new CheckoutManager(h.deps);
		await manager.checkout(pointerPath);
		const result = await manager.checkin(pointerPath);
		expect(result.ok).toBe(true);
		expect(result.kind).toBe('no-op');
		// markers cleared, working copy gone, no new object
		expect(decodePointer(h.pointers.get(pointerPath) as string).record.copyState).toBe('offloaded');
		expect(h.working.has(workingCopyPath(rec.hash as string, rec.originalName))).toBe(false);
		const list = await h.backend.list('charles-main');
		expect(list.entries).toHaveLength(1);
	});

	it('test_checkin_creates_new_additive_version', async () => {
		const h = makeHarness();
		const { pointerPath, rec } = await seedOffloaded(h, 'budget v1');
		const manager = new CheckoutManager(h.deps);
		await manager.checkout(pointerPath);
		// edit the working copy
		const wcPath = workingCopyPath(rec.hash as string, rec.originalName);
		const edited = bytesOf('budget v2 EDITED');
		h.working.set(wcPath, edited);

		const result = await manager.checkin(pointerPath);
		expect(result.ok).toBe(true);
		expect(result.kind).toBe('version');

		const updated = decodePointer(h.pointers.get(pointerPath) as string).record;
		expect(updated.hash).toBe(await sha256Hex(edited));
		expect(requireS3Backend(updated).key).not.toBe(requireS3Backend(rec).key);
		expect(updated.supersedes).toBe(requireS3Backend(rec).key);
		expect(updated.copyState).toBe('offloaded');
		expect(updated.verificationTier).toBe('content');
		expect(updated.id).toBe('ptr-1'); // stable lineage anchor

		// additive: the OLD object is retained AND the new one exists
		expect((await h.backend.head(requireS3Backend(rec).key)).size).toBe(bytesOf('budget v1').length);
		expect((await h.backend.head(requireS3Backend(updated).key)).size).toBe(edited.length);
		// working copy removed
		expect(h.working.has(wcPath)).toBe(false);
	});

	it('test_checkin_verify_failure_keeps_working_copy', async () => {
		const h = makeHarness();
		const { pointerPath, rec } = await seedOffloaded(h, 'budget v1');
		const manager = new CheckoutManager({
			...h.deps,
			// a verifier that always rejects: the upload cannot be proven
			verify: () => Promise.resolve({ ok: false, tier: 'existence', remoteChecksum: null, reason: 'forced mismatch' }),
		});
		await manager.checkout(pointerPath);
		const wcPath = workingCopyPath(rec.hash as string, rec.originalName);
		h.working.set(wcPath, bytesOf('budget v2 EDITED'));

		const result = await manager.checkin(pointerPath);
		expect(result.ok).toBe(false);
		// working copy and checkout markers are kept (the edits are safe locally)
		expect(h.working.has(wcPath)).toBe(true);
		expect(decodePointer(h.pointers.get(pointerPath) as string).record.copyState).toBe('checked-out');
	});

	it('test_checkin_conflict_preserves_and_supersedes', async () => {
		const h = makeHarness();
		const { pointerPath, rec } = await seedOffloaded(h, 'budget v1');
		const manager = new CheckoutManager(h.deps);
		await manager.checkout(pointerPath);
		const wcPath = workingCopyPath(rec.hash as string, rec.originalName);
		h.working.set(wcPath, bytesOf('budget v3 my edits'));

		// simulate the cloud diverging under us: another version v2 was checked in
		// (its object exists) and the pointer now points at it, but our checkout base
		// marker still records v1.
		const v2Bytes = bytesOf('budget v2 from another device');
		const v2Hash = await sha256Hex(v2Bytes);
		const v2Key = 'charles-main/budget--bbbbbb.xlsx';
		await h.backend.put(v2Key, v2Bytes, v2Bytes.length, {
			checksumSha256: await sha256Base64(v2Bytes),
			metadata: { [OBJECT_METADATA_KEYS.sha256]: v2Hash },
		});
		// rewrite the pointer to the diverged current version, keeping our checkout markers
		const current = h.pointers.get(pointerPath) as string;
		const decoded = decodePointer(current);
		h.pointers.set(
			pointerPath,
			encodePointer(
				{ ...decoded.record, hash: v2Hash, backends: [{ type: 's3', bucket: 's3-dev-test', key: v2Key, keyKind: 'hash' }] },
				decoded.body,
				decoded.extraFrontmatter,
			),
		);

		const result = await manager.checkin(pointerPath);
		expect(result.ok).toBe(true);
		expect(result.kind).toBe('conflict');
		// the diverged cloud version was preserved as a visible conflict copy
		expect(h.conflicts.size).toBe(1);
		// the new version supersedes the CURRENT (diverged) key, so both survive
		const updated = decodePointer(h.pointers.get(pointerPath) as string).record;
		expect(updated.supersedes).toBe(v2Key);
		expect(updated.hash).toBe(await sha256Hex(bytesOf('budget v3 my edits')));
	});
});

describe('discard (la-p6-32)', () => {
	it('test_discard_removes_working_copy_no_upload', async () => {
		const h = makeHarness();
		const { pointerPath, rec } = await seedOffloaded(h, 'budget v1');
		const manager = new CheckoutManager(h.deps);
		await manager.checkout(pointerPath);
		const wcPath = workingCopyPath(rec.hash as string, rec.originalName);
		h.working.set(wcPath, bytesOf('budget v2 EDITED but discarded'));

		const result = await manager.discard(pointerPath);
		expect(result.ok).toBe(true);
		expect(h.working.has(wcPath)).toBe(false);
		expect(decodePointer(h.pointers.get(pointerPath) as string).record.copyState).toBe('offloaded');
		// no new object uploaded
		const list = await h.backend.list('charles-main');
		expect(list.entries).toHaveLength(1);
	});
});
