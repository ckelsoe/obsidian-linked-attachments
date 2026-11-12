import type { App } from 'obsidian';
import { AttachmentService } from './attachment-service';
import { encodePointer, type PointerRecord } from '../pointer/codec';
import type { CredentialStore } from '../../credentials';

// refreshPointerBlocks writes through vault.process and re-derives the block
// from the text at write time, so an edit made after the scan read is kept.

const record: PointerRecord = {
	laVersion: 1,
	id: 'ID',
	hash: 'a'.repeat(64),
	backends: [{ type: 's3', bucket: 'b', key: 'k', keyKind: 'hash' }],
	originalName: 'a.pdf',
	originalExt: 'pdf',
	originalPath: 'a.pdf',
	byteSize: 1,
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
};

const fmEnd = (text: string): number => text.indexOf('\n---\n', 4) + 5;

describe('refreshPointerBlocks', () => {
	it('refreshes a stale block through vault.process and keeps a concurrent edit', async () => {
		const both: PointerRecord = {
			...record,
			backends: [...record.backends, { type: 'local', path: 'k' }],
		};
		const fresh = encodePointer(both, 'body\n');
		const oneBackend = encodePointer(record, 'body\n');
		// Frontmatter lists two backends; the block still shows one.
		const stale =
			fresh.slice(0, fmEnd(fresh)) + oneBackend.slice(fmEnd(oneBackend));
		expect(stale).not.toBe(fresh);

		const file = { path: 'p.md' };
		const other = { path: 'note.md' };
		const files = new Map<object, string>([
			[file, stale],
			[other, '# plain note\n'],
		]);
		const processed: object[] = [];
		const vault = {
			getMarkdownFiles: () => [...files.keys()],
			read: (f: object) => Promise.resolve(files.get(f) ?? ''),
			process: (f: object, fn: (data: string) => string) => {
				processed.push(f);
				// The user edits the note between the scan read and the write.
				const current = (files.get(f) ?? '') + 'added later\n';
				const next = fn(current);
				files.set(f, next);
				return Promise.resolve(next);
			},
		};
		const service = new AttachmentService(
			{ vault } as unknown as App,
			{} as CredentialStore,
			() => {
				throw new Error('config not needed');
			},
		);

		expect(await service.refreshPointerBlocks()).toBe(1);
		expect(processed).toEqual([file]);
		expect(files.get(file)).toBe(fresh + 'added later\n');
		expect(files.get(other)).toBe('# plain note\n');
	});
});
