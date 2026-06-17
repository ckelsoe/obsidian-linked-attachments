import { App, TFile } from 'obsidian';
import { S3AddressingStyle, CredentialStore } from '../../credentials';
import { S3ConnectionConfig } from '../../s3-url';
import { S3Backend } from '../storage/s3-backend';
import { requestUrlTransport } from '../storage/requesturl-transport';
import { toArrayBuffer } from '../storage/body';
import { offloadFile, OffloadDeps, OffloadResult } from '../offload/pipeline';
import { ladderVerifier } from '../offload/verify';
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

	async offload(file: TFile): Promise<OffloadResult> {
		const config = this.getConfig();
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		const deps: OffloadDeps = {
			backend: this.backend(config),
			bucket: config.bucket,
			vaultPrefix: config.vaultPrefix !== undefined && config.vaultPrefix.length > 0 ? config.vaultPrefix : this.app.vault.getName(),
			writePointer: (path, content) => this.writePointer(path, content),
			trashOriginal: (path) => this.trashPath(path),
			newId: () => generateId(),
			now: () => new Date().toISOString(),
			verify: ladderVerifier,
		};
		return offloadFile({ path: file.path, bytes, contentType: contentTypeForExtension(file.extension) }, deps);
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

		await this.ensureParentFolder(record.originalPath);
		await this.app.vault.createBinary(record.originalPath, toArrayBuffer(bytes));
		await this.app.fileManager.trashFile(pointer);
		return { ok: true, restoredPath: record.originalPath, error: null };
	}

	// --- internals --------------------------------------------------------------

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
