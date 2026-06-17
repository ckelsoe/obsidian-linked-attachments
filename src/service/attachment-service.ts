import { App, TFile, requestUrl } from 'obsidian';
import { signRequest } from '../../sigv4';
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
import { runBatch, BatchItem, BatchProgress } from '../offload/batch';
import { createJournal, setStage, serializeJournal, parseJournal, unfinishedItems, OffloadJournal, JournalStage } from '../offload/journal';
import { scanReconcile, linkUnlinked, ReconcileFinding } from '../reconcile/scanner';
import { buildManifestFromPointers, PointerSource } from '../manifest/manifest';
import { cleanupIncompleteUploads, buildListUploadsUrl, buildAbortUploadUrl, MultipartTransport, CleanupResult } from '../storage/multipart';
import { decodePointer, encodePointer, PointerRecord } from '../pointer/codec';
import { scanForAdoption, adoptByKey, mirrorKeyToVaultPath, AdoptRow, AdoptScanResult } from '../adopt/adopt-scan';
import { planAdoption } from '../adopt/adopt-plan';
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

	// Reconciliation scan (the moat): diff the vault's pointers against what is in
	// the bucket into the four outcomes (healthy / broken / unlinked / drift).
	// Strictly read-only - LIST, and HEAD only when deep is asked for.
	async reconcile(deep = false): Promise<ReconcileFinding[]> {
		const config = this.getConfig();
		const sources: PointerSource[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const frontmatter: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (frontmatter === undefined || !('la_version' in frontmatter)) {
				continue;
			}
			try {
				const record = decodePointer(await this.app.vault.read(file)).record;
				sources.push({ pointerPath: file.path, record });
			} catch {
				// not a valid pointer; skip
			}
		}
		const manifest = buildManifestFromPointers(sources);
		return scanReconcile(this.backend(config), Object.values(manifest.entries), { deep });
	}

	// Find and abort incomplete multipart uploads, stopping same-session billing from
	// a dropped upload (spec Path 10). The durable backstop is the bucket's
	// AbortIncompleteMultipartUpload lifecycle rule (a one-time console step).
	async cleanupIncompleteUploads(): Promise<CleanupResult> {
		return cleanupIncompleteUploads(this.multipartTransport());
	}

	// The single v1 remediation: create pointers for the unlinked candidates. Broken
	// and drift findings are never touched (resolver is v2).
	async linkFindings(findings: ReconcileFinding[]): Promise<{ created: number; failed: number }> {
		const pointers = linkUnlinked(findings, {}, { bucket: this.getConfig().bucket, newId: () => generateId(), now: () => new Date().toISOString() });
		let created = 0;
		let failed = 0;
		for (const pointer of pointers) {
			try {
				await this.writePointer(pointer.pointerPath, encodePointer(pointer.record, ''));
				created++;
			} catch {
				failed++;
			}
		}
		return { created, failed };
	}

	// Adopt-from-bucket: LIST under an optional prefix and classify each object
	// against what the vault already has (pointer keys + existing paths), so the
	// checklist can hide already-adopted objects and flag collisions. LIST only.
	async adoptScan(prefix: string, destinationFolder: string): Promise<AdoptScanResult> {
		const config = this.getConfig();
		const existingVaultPaths = new Set(this.app.vault.getFiles().map((file) => file.path));
		const existingPointerKeys = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const frontmatter: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const key = frontmatter?.['la_key'];
			if (typeof key === 'string') {
				existingPointerKeys.add(key);
			}
		}
		return scanForAdoption({
			backend: this.backend(config),
			prefix: prefix.length > 0 ? prefix : undefined,
			destinationFolder: destinationFolder.length > 0 ? destinationFolder : undefined,
			existingPointerKeys,
			existingVaultPaths,
		});
	}

	// Create pointer notes for the selected adoptable rows. planAdoption guards that
	// only adoptable rows ever become pointers; writePointer guards against an
	// existing file at the path (so a race still never overwrites).
	async adoptRows(rows: AdoptRow[]): Promise<{ created: number; failed: number }> {
		const pointers = planAdoption(rows, { bucket: this.getConfig().bucket, newId: () => generateId(), now: () => new Date().toISOString() });
		let created = 0;
		let failed = 0;
		for (const pointer of pointers) {
			try {
				await this.writePointer(pointer.pointerPath, encodePointer(pointer.record, ''));
				created++;
			} catch {
				failed++;
			}
		}
		return { created, failed };
	}

	// Paste-a-key: adopt one object by its exact key (a single HEAD, no LIST). The
	// vault path mirrors the key unless the caller overrides it.
	async adoptKey(key: string, vaultPath?: string): Promise<{ ok: boolean; pointerPath: string | null; error: string | null }> {
		const config = this.getConfig();
		const placement = { vaultPath: vaultPath !== undefined && vaultPath.length > 0 ? vaultPath : mirrorKeyToVaultPath(key, {}) };
		try {
			const result = await adoptByKey(this.backend(config), key, placement, {
				bucket: config.bucket,
				newId: () => generateId(),
				now: () => new Date().toISOString(),
			});
			if ('collision' in result) {
				return { ok: false, pointerPath: null, error: 'a pointer already exists for this object' };
			}
			await this.writePointer(result.pointerPath, encodePointer(result.record, ''));
			return { ok: true, pointerPath: result.pointerPath, error: null };
		} catch (error) {
			return { ok: false, pointerPath: null, error: describe(error) };
		}
	}

	// B7 batch dry-run: the per-file plan for a selection, for the preview table.
	async planOffloadMany(files: TFile[]): Promise<OffloadPlan[]> {
		const plans: OffloadPlan[] = [];
		for (const file of files) {
			plans.push(await this.planOffload(file));
		}
		return plans;
	}

	// Batch offload: run the selection one file at a time, reporting per-file
	// progress for the H5 modal. One file's failure never aborts the batch. A session
	// journal is written before the batch and updated per file; it is deleted when the
	// batch finishes, so it only survives a crash - making recovery deterministic.
	async offloadMany(
		files: TFile[],
		onProgress?: (item: BatchItem<OffloadResult>, progress: BatchProgress<OffloadResult>) => void,
	): Promise<BatchProgress<OffloadResult>> {
		const batchId = generateId();
		let journal = createJournal(batchId, files.map((f) => f.path), new Date().toISOString());
		await this.writeJournal(journal);
		try {
			return await runBatch<TFile, OffloadResult>({
				items: files,
				idOf: (file) => file.path,
				run: async (file) => {
					const result = await this.offload(file);
					journal = setStage(journal, file.path, journalStageFor(result));
					await this.writeJournal(journal);
					return { ok: result.ok, value: result, error: result.error };
				},
				onProgress,
			});
		} finally {
			// The batch completed (no crash); the journal is no longer needed.
			await this.deleteJournal(batchId);
		}
	}

	// Resume any offload interrupted by a crash: read each leftover journal and
	// re-offload the unfinished items whose original file still exists (the pipeline
	// re-verifies an already-uploaded object rather than trusting the key). A
	// committed-then-trashed item whose original is gone is simply skipped.
	async resumeInterrupted(): Promise<{ journals: number; resumed: number; failed: number }> {
		const journals = await this.readJournals();
		let resumed = 0;
		let failed = 0;
		for (const journal of journals) {
			for (const item of unfinishedItems(journal)) {
				const file = this.app.vault.getAbstractFileByPath(item.path);
				if (file instanceof TFile) {
					const result = await this.offload(file);
					if (result.ok) {
						resumed++;
					} else {
						failed++;
					}
				}
			}
			await this.deleteJournal(journal.batchId);
		}
		return { journals: journals.length, resumed, failed };
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

	// --- offload-session journal persistence (the plugin's own folder) ----------

	private journalDir(): string {
		return `${this.app.vault.configDir}/plugins/linked-attachments/sessions`;
	}

	private async writeJournal(journal: OffloadJournal): Promise<void> {
		const dir = this.journalDir();
		if (!(await this.app.vault.adapter.exists(dir))) {
			await this.app.vault.adapter.mkdir(dir);
		}
		await this.app.vault.adapter.write(`${dir}/${journal.batchId}.json`, serializeJournal(journal));
	}

	private async deleteJournal(batchId: string): Promise<void> {
		const path = `${this.journalDir()}/${batchId}.json`;
		if (await this.app.vault.adapter.exists(path)) {
			await this.app.vault.adapter.remove(path);
		}
	}

	private async readJournals(): Promise<OffloadJournal[]> {
		const dir = this.journalDir();
		if (!(await this.app.vault.adapter.exists(dir))) {
			return [];
		}
		const journals: OffloadJournal[] = [];
		for (const path of (await this.app.vault.adapter.list(dir)).files) {
			if (!path.endsWith('.json')) {
				continue;
			}
			const parsed = parseJournal(await this.app.vault.adapter.read(path));
			if (parsed.ok) {
				journals.push(parsed.journal);
			} else {
				// A corrupt journal is discardable (the manifest-is-output discipline).
				await this.app.vault.adapter.remove(path);
			}
		}
		return journals;
	}

	// A signed transport for the multipart LIST/ABORT verbs, which the S3Backend does
	// not expose. Signs each request with SigV4 over requestUrl, like the connection
	// test. The host header is dropped (the client sets it from the URL).
	private multipartTransport(): MultipartTransport {
		const config = this.getConfig();
		const send = async (method: 'GET' | 'DELETE', url: string): Promise<{ status: number; text: string }> => {
			const creds = this.credentials.getCredentials();
			if (creds === null) {
				throw new Error('credentials are not configured');
			}
			const signed = await signRequest({
				method,
				url,
				region: config.region.length > 0 ? config.region : 'us-east-1',
				service: 's3',
				accessKeyId: creds.accessKeyId,
				secretAccessKey: creds.secretAccessKey,
			});
			const headers = { ...signed.headers };
			delete headers.host;
			const response = await requestUrl({ url: signed.url, method, headers, throw: false });
			return { status: response.status, text: response.text };
		};
		const s3Config = { endpoint: config.endpoint, region: config.region, bucket: config.bucket, addressingStyle: config.addressingStyle };
		return {
			list: () => send('GET', buildListUploadsUrl(s3Config)),
			abort: (key, uploadId) => send('DELETE', buildAbortUploadUrl(s3Config, key, uploadId)),
		};
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
// Map an offload result to the journal stage it reached, so recovery knows whether
// the file is done (removed) or still needs finishing.
function journalStageFor(result: OffloadResult): JournalStage {
	if (!result.ok) {
		return 'failed';
	}
	return result.removed ? 'removed' : result.reachedStage;
}

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
