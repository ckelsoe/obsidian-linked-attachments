import { App, TFile, requestUrl } from 'obsidian';
import { signRequest } from '../../sigv4';
import { S3AddressingStyle, CredentialStore } from '../../credentials';
import { S3ConnectionConfig } from '../../s3-url';
import { S3Backend } from '../storage/s3-backend';
import { LocalBackend, osTempDir, resolveLocalRoot } from '../storage/local-backend';
import { requestUrlTransport } from '../storage/requesturl-transport';
import { toArrayBuffer } from '../storage/body';
import { StorageMode } from '../../settings';
import { offloadFile, OffloadDeps, OffloadResult, OffloadTarget } from '../offload/pipeline';
import { planOffload, OffloadPlan } from '../offload/plan';
import { ladderVerifier } from '../offload/verify';
import { runTrustRehearsal, TrustRehearsalResult, TrustStage } from '../onboard/trust-ladder';
import { rewriteEmbedsInNotes, RewriteDirection } from '../scan/embed-rewrite';
import { runBatch, BatchItem, BatchProgress } from '../offload/batch';
import { createJournal, setStage, serializeJournal, parseJournal, unfinishedItems, OffloadJournal, JournalStage } from '../offload/journal';
import { scanReconcile, linkUnlinked, ReconcileFinding } from '../reconcile/scanner';
import { buildManifestFromPointers, PointerSource } from '../manifest/manifest';
import { buildHashIndex, lookupByHash, rememberObject, HashIndex } from '../offload/dedup';
import { CheckoutManager, CheckoutDeps, CheckoutResult, CheckinResult } from '../checkout/checkout-manager';
import { dirtyState, DirtyState, readCheckoutBase, workingCopyPath } from '../checkout/checkout-state';
import { cleanupIncompleteUploads, buildListUploadsUrl, buildAbortUploadUrl, MultipartTransport, CleanupResult } from '../storage/multipart';
import { BackendRef, BackendType, decodePointer, encodePointer, localBackend, PointerRecord, refreshManagedBlock } from '../pointer/codec';
import { StorageBackend } from '../storage/backend';
import { scanForAdoption, adoptByKey, mirrorKeyToVaultPath, AdoptRow, AdoptScanResult } from '../adopt/adopt-scan';
import { planAdoption } from '../adopt/adopt-plan';
import { sha256Base64, sha256Hex } from '../hash/sha256';
import { contentTypeForExtension } from './content-type';
import { restoreTargetPath } from './restore-path';

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
	storageMode: StorageMode;
	localRoot: string;
}

export interface RestoreResult {
	ok: boolean;
	restoredPath: string | null;
	error: string | null;
}

// A pointer with at least one backend that failed its existence check.
export interface BackendIntegrityFinding {
	pointerPath: string;
	name: string;
	broken: BackendType[];
	totalBackends: number;
}

export interface MirrorResult {
	added: number; // pointers that gained the mirror backend
	skipped: number; // already had it, or no source backend to copy from
	failed: number; // source unreadable/drifted, or the mirror write did not verify
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
		const manifest = buildManifestFromPointers(await this.collectPointerSources());
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
		// One hash index for the whole batch, so two identical files in the same
		// selection link to one object (the index accumulates as each file commits).
		const hashIndex = await this.buildHashIndex();
		try {
			return await runBatch<TFile, OffloadResult>({
				items: files,
				idOf: (file) => file.path,
				run: async (file) => {
					const result = await this.offload(file, hashIndex);
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
		const hashIndex = await this.buildHashIndex();
		for (const journal of journals) {
			for (const item of unfinishedItems(journal)) {
				const file = this.app.vault.getAbstractFileByPath(item.path);
				if (file instanceof TFile) {
					const result = await this.offload(file, hashIndex);
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

	async offload(file: TFile, hashIndex?: HashIndex): Promise<OffloadResult> {
		const config = this.getConfig();
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		// The content-dedup index: a caller-shared one (batch / resume) accumulates
		// across files; a standalone offload rebuilds it from the vault's pointers.
		const index = hashIndex ?? (await this.buildHashIndex());
		// Capture the notes that embed this attachment BEFORE the pipeline trashes
		// the original, so the rewrite can run against a stable backlink set.
		const embeddingNotes = this.notesLinking(file.path);
		const deps: OffloadDeps = {
			targets: this.offloadTargets(config),
			bucket: config.bucket,
			vaultPrefix: this.resolveVaultPrefix(config),
			writePointer: (path, content) => this.writePointer(path, content),
			trashOriginal: (path) => this.trashPath(path),
			newId: () => generateId(),
			now: () => new Date().toISOString(),
			verify: ladderVerifier,
			// Content-dedup links to an existing S3 object instead of uploading a
			// duplicate (spec section 10). It is an S3-side optimization, so it applies
			// only when S3 is the sole destination; paired/local offloads always write
			// the local copy fresh. The pipeline still verifies before trashing.
			findExistingByHash: config.storageMode === 's3-only' ? (hash) => Promise.resolve(lookupByHash(index, hash)) : undefined,
		};
		const result = await offloadFile({ path: file.path, bytes, contentType: contentTypeForExtension(file.extension) }, deps);
		// Keep the live index current so a later identical file (same batch) dedups.
		if (result.ok && result.record !== null) {
			rememberObject(index, result.record);
		}
		// Only after the pointer is committed: rewrite ![[file.ext]] -> ![[file.ext.md]]
		// so the embeds transclude the pointer. Applies to a deduped offload too (the
		// file is offloaded either way). A rewrite failure is non-fatal - the file is
		// already safely offloaded; the embeds still resolve to the pointer by
		// Obsidian's basename rule anyway.
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

		// Restore next to the pointer's CURRENT location, not the path recorded at
		// offload time. The pointer note is the in-vault representation: if its folder
		// was renamed or it was moved (here or via sync), the recorded path is stale,
		// and restoring there would recreate the old folder and leave the new one empty.
		const targetPath = restoreTargetPath(pointer.path, record.originalName);

		if (this.app.vault.getAbstractFileByPath(targetPath) !== null) {
			return { ok: false, restoredPath: null, error: `a file already exists at ${targetPath}; not overwriting` };
		}

		// Fetch from the pointer's backends in read-preference order (prefer local),
		// verifying each candidate against the recorded hash and falling back to the
		// next backend if one is unreachable or drifted. Restore is a verify path too:
		// never write back bytes that do not match the recorded identity.
		const fetched = await this.fetchFromBackends(record, config);
		if (!fetched.ok) {
			return { ok: false, restoredPath: null, error: fetched.error };
		}
		const bytes = fetched.bytes;

		// Capture the notes embedding the pointer before it is removed.
		const embeddingNotes = this.notesLinking(pointer.path);

		await this.ensureParentFolder(targetPath);
		await this.app.vault.createBinary(targetPath, toArrayBuffer(bytes));
		// Rewrite ![[file.ext.md]] -> ![[file.ext]] while the pointer still exists, so
		// no embed is left dangling between the rewrite and the pointer removal.
		await this.rewriteEmbeds(record.originalName, embeddingNotes, 'to-attachment');
		await this.app.fileManager.trashFile(pointer);
		return { ok: true, restoredPath: targetPath, error: null };
	}

	// --- checkout / check-in (spec section 4a, desktop-only) ---------------------

	// Check out a pointer: download + verify the bytes, write the editable working
	// copy to the sync-excluded checkout dir, mark the pointer, and open it natively.
	async checkout(pointer: TFile, opts: { force?: boolean } = {}): Promise<CheckoutResult> {
		return this.checkoutManager().checkout(pointer.path, opts);
	}

	// Check in a pointer: re-hash the working copy and, if changed, PUT a new verified
	// version (additive) before advancing the pointer; release the lock.
	async checkin(pointer: TFile): Promise<CheckinResult> {
		return this.checkoutManager().checkin(pointer.path);
	}

	// Discard a checkout: release the lock and remove the working copy, no upload.
	async discardCheckout(pointer: TFile): Promise<{ ok: boolean; error: string | null }> {
		return this.checkoutManager().discard(pointer.path);
	}

	// The dirty state of a pointer for the status indicator (green/orange/red).
	async dirtyStateFor(pointer: TFile): Promise<DirtyState> {
		const decoded = decodePointer(await this.app.vault.read(pointer));
		const base = readCheckoutBase(decoded) ?? decoded.record.hash;
		if (decoded.record.copyState !== 'checked-out' || base === null) {
			return dirtyState(decoded.record, null);
		}
		const wcPath = workingCopyPath(base, decoded.record.originalName);
		let workingHash: string | null = null;
		if (await this.app.vault.adapter.exists(wcPath)) {
			workingHash = await sha256Hex(new Uint8Array(await this.app.vault.adapter.readBinary(wcPath)));
		}
		return dirtyState(decoded.record, workingHash);
	}

	// Pointer paths currently marked checked-out, for the quit guard seed.
	async checkedOutPointers(): Promise<string[]> {
		const paths: string[] = [];
		for (const { pointerPath, record } of await this.collectPointerSources()) {
			if (record.copyState === 'checked-out') {
				paths.push(pointerPath);
			}
		}
		return paths;
	}

	private checkoutManager(): CheckoutManager {
		const config = this.getConfig();
		const adapter = this.app.vault.adapter;
		const deps: CheckoutDeps = {
			backend: this.backend(config),
			vaultPrefix: this.resolveVaultPrefix(config),
			readPointer: async (path) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) {
					throw new Error(`no pointer note at ${path}`);
				}
				return this.app.vault.read(file);
			},
			writePointer: async (path, text) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) {
					throw new Error(`no pointer note at ${path}`);
				}
				await this.app.vault.modify(file, text);
			},
			writeWorkingCopy: async (path, bytes) => {
				await this.ensureAdapterDir(parentDir(path));
				await adapter.writeBinary(path, toArrayBuffer(bytes));
			},
			readWorkingCopy: async (path) => new Uint8Array(await adapter.readBinary(path)),
			removeWorkingCopy: (path) => adapter.remove(path),
			workingCopyExists: (path) => adapter.exists(path),
			openInDefaultApp: (path) => this.app.openWithDefaultApp(path),
			writeConflictCopy: async (path, bytes) => {
				await this.ensureParentFolder(path);
				await this.app.vault.createBinary(path, toArrayBuffer(bytes));
			},
			host: () => this.deviceHost(),
			now: () => new Date().toISOString(),
			verify: ladderVerifier,
		};
		return new CheckoutManager(deps);
	}

	// A stable, human-distinguishable per-device id for the advisory lock, persisted
	// in device-local storage (so it never syncs and differs per device).
	private deviceHost(): string {
		const key = 'linked-attachments-device-host';
		const existing: unknown = this.app.loadLocalStorage(key);
		if (typeof existing === 'string' && existing.length > 0) {
			return existing;
		}
		const id = `device-${generateId()}`;
		this.app.saveLocalStorage(key, id);
		return id;
	}

	private async ensureAdapterDir(dir: string): Promise<void> {
		if (dir.length === 0) {
			return;
		}
		let acc = '';
		for (const part of dir.split('/')) {
			if (part.length === 0) {
				continue;
			}
			acc = acc.length === 0 ? part : `${acc}/${part}`;
			if (!(await this.app.vault.adapter.exists(acc))) {
				try {
					await this.app.vault.adapter.mkdir(acc);
				} catch {
					// tolerate a concurrent creation
				}
			}
		}
	}

	// --- internals --------------------------------------------------------------

	// Decode every pointer note in the vault into a PointerSource. The single
	// gather used by reconcile and the content-dedup index, so both read identity
	// from frontmatter the same way (la_version present -> attempt decode; skip junk).
	private async collectPointerSources(): Promise<PointerSource[]> {
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
		return sources;
	}

	// The hash -> object index for content-dedup, rebuilt from the vault's pointer
	// notes (the source of truth; not a synced datastore - spec section 10).
	private async buildHashIndex(): Promise<HashIndex> {
		return buildHashIndex(await this.collectPointerSources());
	}

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

	// The offload destinations for the active storage mode, in read-preference order
	// (first = preferred read). local-s3 lists the local copy first so a paired
	// object reads from disk, with S3 as the durable off-machine fallback.
	private offloadTargets(config: AttachmentServiceConfig): OffloadTarget[] {
		const s3Target: OffloadTarget = {
			backend: this.backend(config),
			toRef: (key) => ({ type: 's3', bucket: config.bucket, key, keyKind: 'hash' }),
		};
		if (config.storageMode === 's3-only') {
			return [s3Target];
		}
		const localTarget: OffloadTarget = {
			backend: this.localBackend(config),
			// The local path is the object key (the layout already mirrors the vault
			// path); the pointer stores it root-relative so it resolves against the
			// configured root on any machine.
			toRef: (key) => ({ type: 'local', path: key }),
		};
		return config.storageMode === 'local-only' ? [localTarget] : [localTarget, s3Target];
	}

	private localBackend(config: AttachmentServiceConfig): LocalBackend {
		const root = resolveLocalRoot(config.localRoot);
		if (root.length === 0) {
			throw new Error('local storage mode needs a local root path (set it in settings)');
		}
		return new LocalBackend(root);
	}

	// The absolute filesystem path of a pointer's local copy, or null if it has no
	// local backend or no local root is configured. Used to open/reveal the copy,
	// which lives outside the vault.
	localAbsolutePath(record: PointerRecord): string | null {
		const local = localBackend(record);
		if (local === null) {
			return null;
		}
		const root = resolveLocalRoot(this.getConfig().localRoot);
		if (root.length === 0) {
			return null;
		}
		return new LocalBackend(root).displayKey(local.path);
	}

	// Regenerate the managed block of every pointer note (upgrading its open links to
	// the current format), leaving frontmatter and the user body byte-identical.
	// Returns how many notes changed.
	async refreshPointerBlocks(): Promise<number> {
		let refreshed = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const text = await this.app.vault.read(file);
			let record: PointerRecord;
			try {
				record = decodePointer(text).record;
			} catch {
				continue; // not a pointer note
			}
			const updated = refreshManagedBlock(text, record);
			if (updated !== text) {
				await this.app.vault.modify(file, updated);
				refreshed++;
			}
		}
		return refreshed;
	}

	// Download the object (verified against the recorded hash) to a temp file and
	// return its absolute path, so an S3-only pointer with no local copy can still be
	// opened in a default app. Namespaced by the pointer id so distinct objects do
	// not collide in the temp dir.
	async downloadForOpen(record: PointerRecord): Promise<string | null> {
		const fetched = await this.fetchFromBackends(record, this.getConfig());
		if (!fetched.ok) {
			throw new Error(fetched.error);
		}
		const tempBackend = new LocalBackend(osTempDir());
		const cacheKey = `linked-attachments-open/${record.id}/${record.originalName}`;
		await tempBackend.put(cacheKey, fetched.bytes, fetched.bytes.length);
		return tempBackend.displayKey(cacheKey);
	}

	// Find a pointer record by its id (the protocol handler only carries the id).
	async findRecordById(id: string): Promise<PointerRecord | null> {
		for (const file of this.app.vault.getMarkdownFiles()) {
			try {
				const record = decodePointer(await this.app.vault.read(file)).record;
				if (record.id === id) {
					return record;
				}
			} catch {
				// not a pointer note
			}
		}
		return null;
	}

	// Resolve one pointer BackendRef to the StorageBackend and key that read it.
	private backendForRef(ref: BackendRef, config: AttachmentServiceConfig): { backend: StorageBackend; key: string } {
		if (ref.type === 's3') {
			return { backend: this.backend(config), key: ref.key };
		}
		return { backend: this.localBackend(config), key: ref.path };
	}

	// Fetch the object from the pointer's backends in read-preference order (prefer
	// local), verifying each candidate's bytes against the recorded hash. The first
	// backend that returns matching bytes wins; a backend that is unreachable or
	// drifted falls through to the next, so a healthy backup still restores when the
	// preferred copy is missing. Fails only when NO backend can serve the file.
	private async fetchFromBackends(
		record: PointerRecord,
		config: AttachmentServiceConfig,
	): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
		const reasons: string[] = [];
		for (const ref of record.backends) {
			try {
				const { backend, key } = this.backendForRef(ref, config);
				const bytes = new Uint8Array(await (await backend.get(key)).arrayBuffer());
				if (record.hash !== null) {
					if ((await sha256Hex(bytes)) !== record.hash) {
						reasons.push(`${ref.type}: bytes do not match the recorded hash`);
						continue;
					}
				} else if (record.byteSize > 0 && bytes.length !== record.byteSize) {
					// No content hash (an adopted/external object): fall back on a size
					// mismatch so a cloud-only placeholder or a truncated copy is not
					// served as if it were the file, and a good backup is still tried.
					reasons.push(`${ref.type}: size ${bytes.length} does not match the recorded ${record.byteSize}`);
					continue;
				}
				return { ok: true, bytes };
			} catch (error) {
				reasons.push(`${ref.type}: ${describe(error)}`);
			}
		}
		return { ok: false, error: `no backend could return the file (${reasons.join('; ')})` };
	}

	// On-demand integrity check (spec section 7): for every pointer, existence-check
	// each backend it lists (S3 HEAD / local stat) and report the pointers with a
	// missing backend. Read-only - it never writes, deletes, or repairs. A local
	// backend that is not configured (no root) counts as broken for that pointer, so
	// the user is told to set the root rather than silently seeing a false miss.
	async checkBackendIntegrity(): Promise<BackendIntegrityFinding[]> {
		const config = this.getConfig();
		const findings: BackendIntegrityFinding[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			let record: PointerRecord;
			try {
				record = decodePointer(await this.app.vault.read(file)).record;
			} catch {
				continue; // not a pointer note
			}
			const broken: BackendType[] = [];
			for (const ref of record.backends) {
				try {
					const { backend, key } = this.backendForRef(ref, config);
					await backend.head(key);
				} catch {
					broken.push(ref.type);
				}
			}
			if (broken.length > 0) {
				findings.push({ pointerPath: file.path, name: record.originalName, broken, totalBackends: record.backends.length });
			}
		}
		return findings;
	}

	// "Add local mirror" / "Add S3 mirror" migration (spec section 7): for each
	// pointer missing the target backend, read the object once from an existing
	// backend (verified against the recorded hash), write it to the target, verify
	// the copy, and append the new backend ref to the pointer in place. Never removes
	// an existing backend, so an interrupted run is safe to re-run (idempotent: a
	// pointer that already has the target is skipped).
	async addLocalMirror(): Promise<MirrorResult> {
		return this.addMirror('local');
	}

	async addS3Mirror(): Promise<MirrorResult> {
		return this.addMirror('s3');
	}

	private async addMirror(target: BackendType): Promise<MirrorResult> {
		const config = this.getConfig();
		const result: MirrorResult = { added: 0, skipped: 0, failed: 0 };
		for (const file of this.app.vault.getMarkdownFiles()) {
			let decoded;
			try {
				decoded = decodePointer(await this.app.vault.read(file));
			} catch {
				continue; // not a pointer note
			}
			const record = decoded.record;
			const source = record.backends[0];
			if (record.backends.some((backend) => backend.type === target) || source === undefined) {
				result.skipped++;
				continue;
			}
			try {
				const { backend: srcBackend, key: sharedKey } = this.backendForRef(source, config);
				const bytes = new Uint8Array(await (await srcBackend.get(sharedKey)).arrayBuffer());
				if (record.hash !== null) {
					if ((await sha256Hex(bytes)) !== record.hash) {
						result.failed++; // source drifted - do not mirror bad bytes
						continue;
					}
				} else if (record.byteSize > 0 && bytes.length !== record.byteSize) {
					// No content hash (adopted/external): a size mismatch means the source
					// is a placeholder or truncated, so do not propagate it to a new mirror.
					result.failed++;
					continue;
				}
				// The object key is shared across backends (one layout), so the mirror
				// reuses the source's key/path.
				const newRef: BackendRef = target === 'local' ? { type: 'local', path: sharedKey } : { type: 's3', bucket: config.bucket, key: sharedKey, keyKind: 'hash' };
				const { backend: dstBackend, key: dstKey } = this.backendForRef(newRef, config);
				const checksumBase64 = await sha256Base64(bytes);
				await dstBackend.put(dstKey, bytes, bytes.length, { checksumSha256: checksumBase64, contentType: record.contentType });
				const outcome = await ladderVerifier(dstBackend, dstKey, { hash: record.hash ?? '', checksumBase64, size: bytes.length });
				if (!outcome.ok) {
					// The mirror could not be verified; roll it back and count a failure so
					// the pointer is never told it has a backend that is not proven.
					try {
						await dstBackend.delete(dstKey);
					} catch {
						// best effort
					}
					result.failed++;
					continue;
				}
				const updated: PointerRecord = { ...record, backends: [...record.backends, newRef] };
				await this.app.vault.modify(file, encodePointer(updated, decoded.body, decoded.extraFrontmatter));
				result.added++;
			} catch {
				result.failed++;
			}
		}
		return result;
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

function parentDir(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? path.slice(0, slash) : '';
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
