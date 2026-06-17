import { App, TFile } from 'obsidian';
import { S3AddressingStyle, CredentialStore } from '../../credentials';
import { S3ConnectionConfig } from '../../s3-url';
import { S3Backend } from '../storage/s3-backend';
import { requestUrlTransport } from '../storage/requesturl-transport';
import { toArrayBuffer } from '../storage/body';
import { offloadFile, OffloadDeps, OffloadResult } from '../offload/pipeline';
import { planOffload, OffloadPlan } from '../offload/plan';
import { ladderVerifier } from '../offload/verify';
import { runTrustRehearsal, TrustRehearsalResult, TrustStage } from '../onboard/trust-ladder';
import { rewriteEmbedsInNotes, RewriteDirection } from '../scan/embed-rewrite';
import { decodePointer, PointerRecord } from '../pointer/codec';
import { sha256Hex } from '../hash/sha256';
import { contentTypeForExtension } from './content-type';

// The offload / restore orchestration: the thin Obsidian glue that wires the
// proven engine (offload pipeline, verify ladder, codec, S3Backend) to the vault.
// It owns the side effects the pipeline abstracts: reading bytes, writing the
// pointer note, and trashing the original (recoverably, F2). 0.1 scope is the
// safe single-file round-trip; referenced-note embed rewriting is 0.2.

export interface AttachmentServiceConfig {
	endpoint: string;
	region: string;
	bucket: string;
	addressingStyle: S3AddressingStyle;
	vaultPrefix?: string;
}

export interface RestoreResult {
	ok: boolean;
	restoredPath: string | null;
	error: string | null;
}

export class AttachmentService {
	constructor(
		private readonly app: App,
		private readonly credentials: CredentialStore,
		private readonly getConfig: () => AttachmentServiceConfig,
	) {}

	// B7 dry-run: compute where the file would go without uploading anything. The
	// preview modal renders this; the offload below derives the same key from the
	// same module, so the preview never disagrees with the commit.
	async planOffload(file: TFile): Promise<OffloadPlan> {
		const config = this.getConfig();
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		return planOffload(
			{ path: file.path, bytes, contentType: contentTypeForExtension(file.extension) },
			{ vaultPrefix: this.resolveVaultPrefix(config), bucket: config.bucket },
		);
	}

	// S6 first-file trust check: run the four-stage round-trip on a throwaway object
	// against the user's real bucket, so they can watch upload -> verify -> retrieve
	// -> match succeed before trusting a real file. The throwaway key and payload are
	// random; the rehearsal cleans the object up itself.
	async rehearseTrust(onStage?: (stage: TrustStage) => void): Promise<TrustRehearsalResult> {
		const config = this.getConfig();
		const prefix = this.resolveVaultPrefix(config);
		const nonce = generateId();
		const key = `${prefix}/.linked-attachments/rehearsal-${nonce}.txt`;
		const payload = new TextEncoder().encode(`Linked Attachments round-trip rehearsal ${nonce}`);
		return runTrustRehearsal({ backend: this.backend(config), key, payload, onStage });
	}

	async offload(file: TFile): Promise<OffloadResult> {
		const config = this.getConfig();
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		// Capture the notes that embed this attachment BEFORE the pipeline trashes
		// the original, so the rewrite can run against a stable backlink set.
		const embeddingNotes = this.notesLinking(file.path);
		const deps: OffloadDeps = {
			backend: this.backend(config),
			bucket: config.bucket,
			vaultPrefix: this.resolveVaultPrefix(config),
			writePointer: (path, content) => this.writePointer(path, content),
			trashOriginal: (path) => this.trashPath(path),
			newId: () => generateId(),
			now: () => new Date().toISOString(),
			verify: ladderVerifier,
		};
		const result = await offloadFile({ path: file.path, bytes, contentType: contentTypeForExtension(file.extension) }, deps);
		// Only after the pointer is committed: rewrite ![[file.ext]] -> ![[file.ext.md]]
		// so the embeds transclude the pointer. A rewrite failure is non-fatal - the
		// file is already safely offloaded; the embeds simply still point at the raw
		// name (which resolves to the pointer by Obsidian's basename rule anyway).
		if (result.ok) {
			await this.rewriteEmbeds(file.name, embeddingNotes, 'to-pointer');
		}
		return result;
	}

	async restore(pointer: TFile): Promise<RestoreResult> {
		const config = this.getConfig();
		let record: PointerRecord;
		try {
			record = decodePointer(await this.app.vault.read(pointer)).record;
		} catch (error) {
			return { ok: false, restoredPath: null, error: `not a pointer note: ${describe(error)}` };
		}

		if (this.app.vault.getAbstractFileByPath(record.originalPath) !== null) {
			return { ok: false, restoredPath: null, error: `a file already exists at ${record.originalPath}; not overwriting` };
		}

		const got = await this.backend(config).get(record.key);
		const bytes = new Uint8Array(await got.arrayBuffer());
		// Restore is a verify path too: confirm the bytes hash to the recorded
		// identity before writing them back (never restore drifted bytes silently).
		if (record.hash !== null && (await sha256Hex(bytes)) !== record.hash) {
			return { ok: false, restoredPath: null, error: 'downloaded bytes do not match the recorded hash; not writing' };
		}

		// Capture the notes embedding the pointer before it is removed.
		const embeddingNotes = this.notesLinking(pointer.path);

		await this.ensureParentFolder(record.originalPath);
		await this.app.vault.createBinary(record.originalPath, toArrayBuffer(bytes));
		// Rewrite ![[file.ext.md]] -> ![[file.ext]] while the pointer still exists, so
		// no embed is left dangling between the rewrite and the pointer removal.
		await this.rewriteEmbeds(record.originalName, embeddingNotes, 'to-attachment');
		await this.app.fileManager.trashFile(pointer);
		return { ok: true, restoredPath: record.originalPath, error: null };
	}

	// --- internals --------------------------------------------------------------

	// The bucket key prefix that mirrors this vault; an explicit setting wins,
	// else the vault name. Shared by plan and offload so the key matches.
	private resolveVaultPrefix(config: AttachmentServiceConfig): string {
		return config.vaultPrefix !== undefined && config.vaultPrefix.length > 0
			? config.vaultPrefix
			: this.app.vault.getName();
	}

	// The markdown notes whose resolved links include targetPath. Obsidian's
	// metadataCache already resolved every embed, so this is the backlink set for an
	// attachment (offload) or a pointer (restore) without re-scanning the vault.
	private notesLinking(targetPath: string): string[] {
		const sources: string[] = [];
		const resolved = this.app.metadataCache.resolvedLinks;
		for (const source of Object.keys(resolved)) {
			if (source.endsWith('.md') && targetPath in (resolved[source] ?? {})) {
				sources.push(source);
			}
		}
		return sources;
	}

	// Read the given notes, rewrite the embeds in the requested direction, and write
	// back only those that changed. Best-effort: a failure is logged by the caller's
	// guard and never undoes a completed offload/restore.
	private async rewriteEmbeds(attachmentName: string, sourcePaths: string[], direction: RewriteDirection): Promise<number> {
		if (sourcePaths.length === 0) {
			return 0;
		}
		const notes: Array<{ path: string; content: string }> = [];
		for (const path of sourcePaths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				notes.push({ path, content: await this.app.vault.read(file) });
			}
		}
		const { rewrites, embedsRewritten } = rewriteEmbedsInNotes(notes, attachmentName, direction);
		for (const rewrite of rewrites) {
			const file = this.app.vault.getAbstractFileByPath(rewrite.path);
			if (file instanceof TFile) {
				await this.app.vault.modify(file, rewrite.content);
			}
		}
		return embedsRewritten;
	}

	private backend(config: AttachmentServiceConfig): S3Backend {
		const s3Config: S3ConnectionConfig = {
			endpoint: config.endpoint,
			region: config.region,
			bucket: config.bucket,
			addressingStyle: config.addressingStyle,
		};
		return new S3Backend({ config: s3Config, getCredentials: () => this.credentials.getCredentials(), transport: requestUrlTransport });
	}

	private async writePointer(path: string, content: string): Promise<void> {
		if (this.app.vault.getAbstractFileByPath(path) !== null) {
			throw new Error(`a pointer note already exists at ${path}`);
		}
		await this.ensureParentFolder(path);
		await this.app.vault.create(path, content);
	}

	private async trashPath(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file !== null) {
			// Trash via FileManager so the user's deletion preference is honored
			// (F2: never our own hard delete). Verify-before-delete already ran.
			await this.app.fileManager.trashFile(file);
		}
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const slash = path.lastIndexOf('/');
		if (slash < 0) {
			return;
		}
		const dir = path.slice(0, slash);
		if (dir.length > 0 && this.app.vault.getAbstractFileByPath(dir) === null) {
			try {
				await this.app.vault.createFolder(dir);
			} catch {
				// tolerate a concurrent creation
			}
		}
	}
}

// A sortable, collision-resistant id: base36 time + random hex. Not a ULID, but
// monotonic-ish and unique enough for a pointer id.
function generateId(): string {
	const time = Date.now().toString(36);
	const random = Array.from(crypto.getRandomValues(new Uint8Array(6)))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `la-${time}-${random}`;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
