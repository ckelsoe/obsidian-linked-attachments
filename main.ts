import { Notice, Platform, Plugin, TFile } from 'obsidian';
import {
	LinkedAttachmentsSettings,
	DEFAULT_SETTINGS,
	DEFAULT_ACCESS_KEY_SECRET_ID,
	DEFAULT_SECRET_KEY_SECRET_ID,
} from './settings';
import { AutoOffloadController } from './src/service/auto-offload-controller';
import { normalizeRules, rulesFromLegacy } from './src/offload/offload-rules';
import { planVaultSweep, SweepFile } from './src/offload/vault-sweep';
import { CredentialStore, describeError } from './credentials';
import { LinkedAttachmentsSettingTab } from './settings-tab';
import { Logger } from './logger';
import { AttachmentService } from './src/service/attachment-service';
import { OffloadPreviewModal } from './src/ui/offload-preview-modal';
import { TrustRehearsalModal } from './src/ui/trust-rehearsal-modal';
import { LogViewModal } from './src/ui/log-view-modal';
import { BatchOffloadModal } from './src/ui/batch-offload-modal';
import { AdoptModal } from './src/ui/adopt-modal';
import { ReconcileModal } from './src/ui/reconcile-modal';
import { offloadOutcomeLine, pointerTrustLine } from './src/ui/trust-summary';
import { classifyError } from './src/storage/error-state';
import { formatPointerReference } from './src/ui/pointer-reference';
import { decodePointer } from './src/pointer/codec';
import { dirtyColor, dirtyLabel } from './src/checkout/checkout-state';
import { ConfirmModal } from './src/ui/confirm-modal';

// One-time rename: earlier builds defaulted the secret names to the long
// linked-attachments-* form. Map a saved long default to the current short name so
// the field matches the instructions without the user re-linking.
const RENAMED_SECRET_IDS: Record<string, string> = {
	'linked-attachments-access-key-id': DEFAULT_ACCESS_KEY_SECRET_ID,
	'linked-attachments-secret-access-key': DEFAULT_SECRET_KEY_SECRET_ID,
};

// Plugin entry point. Per the workspace code-structure rules this class is wiring
// only: lifecycle, settings persistence, and constructing the services. The
// credential logic lives in CredentialStore; the UI lives in the settings tab.
export default class LinkedAttachmentsPlugin extends Plugin {
	settings!: LinkedAttachmentsSettings;
	credentials!: CredentialStore;
	logger!: Logger;
	attachments!: AttachmentService;
	autoOffload!: AutoOffloadController;
	private dirtyStatusEl: HTMLElement | null = null;
	// Pointer paths currently checked out on this device, for the quit guard.
	private readonly checkedOut = new Set<string>();

	async onload(): Promise<void> {
		await this.loadSettings();

		this.logger = new Logger(this.app, this.manifest.id, () => this.settings.debugLogging);
		this.logger.info('Plugin loaded.', { version: this.manifest.version });

		// Obsidian's SecretStorage is assignable to our structural SecretStore. The
		// store reads the secret NAMES from live settings via a getter, so changing
		// a name in the UI takes effect with no reconstruction.
		this.credentials = new CredentialStore(this.app.secretStorage, () => ({
			accessKeyIdSecretName: this.settings.accessKeyIdSecretName,
			secretAccessKeySecretName: this.settings.secretAccessKeySecretName,
		}));

		this.addSettingTab(new LinkedAttachmentsSettingTab(this.app, this));

		this.attachments = new AttachmentService(this.app, this.credentials, () => ({
			endpoint: this.settings.endpoint,
			region: this.settings.region,
			bucket: this.settings.bucket,
			addressingStyle: this.settings.addressingStyle,
			storageMode: this.settings.storageMode,
			localRoot: this.settings.localRoot,
		}));

		// Offload the active file (an attachment opened in a tab) to storage.
		this.addCommand({
			id: 'offload-active-file',
			name: 'Offload the active file to storage',
			checkCallback: (checking: boolean): boolean => {
				const file = this.app.workspace.getActiveFile();
				if (file === null) {
					return false;
				}
				if (!checking) {
					void this.runOffload(file);
				}
				return true;
			},
		});

		// S6 first-file trust check: rehearse a full round-trip on a throwaway object
		// so the user can confirm their bucket works before trusting a real file.
		this.addCommand({
			id: 'rehearse-round-trip',
			name: 'Rehearse a round-trip on a test file',
			checkCallback: (checking: boolean): boolean => {
				const ready = this.settings.endpoint.length > 0 && this.settings.bucket.length > 0 && this.credentials.hasCompleteCredentials();
				if (!ready) {
					return false;
				}
				if (!checking) {
					new TrustRehearsalModal(this.app, this.attachments, this.logger, (error) => {
						this.logger.error('Trust rehearsal threw.', { error: describeError(error) });
					}).open();
				}
				return true;
			},
		});

		// View the activity log in-app and copy it for a bug report.
		this.addCommand({
			id: 'view-activity-log',
			name: 'View the activity log',
			callback: () => {
				new LogViewModal(this.app, () => this.logger.readRecent()).open();
			},
		});

		// Resume an offload interrupted by a crash, from the session journal.
		this.addCommand({
			id: 'resume-interrupted-offload',
			name: 'Resume an interrupted offload',
			checkCallback: (checking: boolean): boolean => {
				const ready = this.settings.endpoint.length > 0 && this.settings.bucket.length > 0 && this.credentials.hasCompleteCredentials();
				if (!ready) {
					return false;
				}
				if (!checking) {
					void this.runResume();
				}
				return true;
			},
		});

		// Sweep: apply the per-extension offload rules across the whole vault at once,
		// offloading every existing file that matches (the retroactive counterpart to
		// auto-offload, which only acts on new files going forward).
		this.addCommand({
			id: 'scan-vault-and-offload-by-type',
			name: 'Scan vault and offload by file type',
			checkCallback: (checking: boolean): boolean => {
				const ready = this.settings.endpoint.length > 0 && this.settings.bucket.length > 0 && this.credentials.hasCompleteCredentials();
				if (!ready) {
					return false;
				}
				if (!checking) {
					this.runVaultSweep();
				}
				return true;
			},
		});

		// Reconcile: diff the vault's pointers against the bucket (the four outcomes).
		this.addCommand({
			id: 'reconcile-with-storage',
			name: 'Reconcile with storage',
			checkCallback: (checking: boolean): boolean => {
				const ready = this.settings.endpoint.length > 0 && this.settings.bucket.length > 0 && this.credentials.hasCompleteCredentials();
				if (!ready) {
					return false;
				}
				if (!checking) {
					new ReconcileModal(this.app, this.attachments, (error) => {
						this.logger.error('Reconcile threw.', { error: describeError(error) });
					}).open();
				}
				return true;
			},
		});

		// Adopt-from-bucket: catalogue objects already in the bucket as pointer notes.
		this.addCommand({
			id: 'adopt-from-storage',
			name: 'Adopt files from storage',
			checkCallback: (checking: boolean): boolean => {
				const ready = this.settings.endpoint.length > 0 && this.settings.bucket.length > 0 && this.credentials.hasCompleteCredentials();
				if (!ready) {
					return false;
				}
				if (!checking) {
					new AdoptModal(this.app, this.attachments, (error) => {
						this.logger.error('Adopt threw.', { error: describeError(error) });
					}).open();
				}
				return true;
			},
		});

		// Restore the active pointer note (a *.md pointer) back to the vault.
		this.addCommand({
			id: 'restore-active-pointer',
			name: 'Restore the active pointer note',
			checkCallback: (checking: boolean): boolean => {
				const file = this.app.workspace.getActiveFile();
				if (file === null || file.extension !== 'md') {
					return false;
				}
				if (!checking) {
					void this.runRestore(file);
				}
				return true;
			},
		});

		// Check out the active pointer note to edit it natively (desktop-only).
		this.addCommand({
			id: 'checkout-active-pointer',
			name: 'Check out the active pointer note to edit',
			checkCallback: (checking: boolean): boolean => {
				if (!Platform.isDesktop) {
					return false;
				}
				const file = this.activePointer();
				if (file === null || this.pointerCopyState(file) === 'checked-out') {
					return false;
				}
				if (!checking) {
					void this.runCheckout(file);
				}
				return true;
			},
		});

		// Check in the active pointer note (save the edited working copy as a version).
		this.addCommand({
			id: 'checkin-active-pointer',
			name: 'Check in the active pointer note',
			checkCallback: (checking: boolean): boolean => {
				if (!Platform.isDesktop) {
					return false;
				}
				const file = this.activePointer();
				if (file === null || this.pointerCopyState(file) !== 'checked-out') {
					return false;
				}
				if (!checking) {
					void this.runCheckin(file);
				}
				return true;
			},
		});

		// Discard the active pointer note's checkout (drop the working copy, no upload).
		this.addCommand({
			id: 'discard-active-checkout',
			name: 'Discard the active checkout',
			checkCallback: (checking: boolean): boolean => {
				if (!Platform.isDesktop) {
					return false;
				}
				const file = this.activePointer();
				if (file === null || this.pointerCopyState(file) !== 'checked-out') {
					return false;
				}
				if (!checking) {
					void this.runDiscardCheckout(file);
				}
				return true;
			},
		});

		// Right-click affordances: "Offload to storage" on a normal file, and
		// "Restore from storage" on a pointer note (detected by its la_* frontmatter).
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile)) {
					return;
				}
				if (file.extension === 'md') {
					const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
					if (frontmatter !== undefined && 'la_version' in frontmatter) {
						menu.addItem((item) => {
							item
								.setTitle('Restore from storage')
								.setIcon('download-cloud')
								.onClick(() => {
									void this.runRestore(file);
								});
						});
						menu.addItem((item) => {
							item
								.setTitle('Check storage status')
								.setIcon('shield-check')
								.onClick(() => {
									void this.showPointerStatus(file);
								});
						});
						// The mobile affordance: copy the bucket + key + honest size/
						// format so the user can open the object in their own S3 app.
						// Useful on desktop too (paste into an S3 browser).
						menu.addItem((item) => {
							item
								.setTitle('Copy storage reference')
								.setIcon('clipboard-copy')
								.onClick(() => {
									void this.copyPointerReference(file);
								});
						});
						// Checkout/check-in cycle (spec section 4a), desktop-only.
						if (Platform.isDesktop) {
							if (frontmatter['la_copy_state'] === 'checked-out') {
								menu.addItem((item) => {
									item
										.setTitle('Check in (save a new version)')
										.setIcon('check-circle')
										.onClick(() => {
											void this.runCheckin(file);
										});
								});
								menu.addItem((item) => {
									item
										.setTitle('Discard checkout')
										.setIcon('rotate-ccw')
										.onClick(() => {
											void this.runDiscardCheckout(file);
										});
								});
							} else {
								menu.addItem((item) => {
									item
										.setTitle('Check out to edit')
										.setIcon('file-edit')
										.onClick(() => {
											void this.runCheckout(file);
										});
								});
							}
						}
					}
					return;
				}
				menu.addItem((item) => {
					item
						.setTitle('Offload to storage')
						.setIcon('upload-cloud')
						.onClick(() => {
							void this.runOffload(file);
						});
				});
			}),
		);

		// Multi-select in the file explorer: batch-offload the selected attachments.
		this.registerEvent(
			this.app.workspace.on('files-menu', (menu, files) => {
				const attachments = files.filter((f): f is TFile => f instanceof TFile && f.extension !== 'md');
				if (attachments.length < 2) {
					return;
				}
				menu.addItem((item) => {
					item
						.setTitle('Offload to storage')
						.setIcon('upload-cloud')
						.onClick(() => {
							this.runBatchOffload(attachments);
						});
				});
			}),
		);

		// Auto-offload on add (spec section 4b), opt-in. The controller decides via
		// the pure policy and prompts (default) or schedules an idle offload. Vault
		// events are registered only AFTER layout-ready, so the create handler does
		// not fire for every existing file during the initial vault index.
		this.autoOffload = new AutoOffloadController({
			app: this.app,
			isDesktop: Platform.isDesktop,
			getConfig: () => ({
				enabled: this.settings.autoOffloadEnabled,
				rules: this.settings.offloadRules,
				triggerMode: this.settings.autoOffloadTriggerMode,
				idleMinutes: this.settings.autoOffloadIdleMinutes,
			}),
			isReady: () => this.storageConfigured(),
			offloadNow: (file) => this.executeOffload(file),
			onError: (error) => this.logger.error('Auto-offload threw.', { error: describeError(error) }),
		});
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.vault.on('create', (file) => {
					if (file instanceof TFile) {
						this.autoOffload.onCreate(file);
					}
				}),
			);
			this.registerEvent(
				this.app.vault.on('modify', (file) => {
					if (file instanceof TFile) {
						this.autoOffload.onModify(file);
					}
				}),
			);
			// Seed the checked-out set (desktop) so the quit guard knows about checkouts
			// from a previous session, and prime the status indicator.
			if (Platform.isDesktop) {
				void this.attachments.checkedOutPointers().then((paths) => {
					for (const path of paths) {
						this.checkedOut.add(path);
					}
				});
				void this.updateDirtyStatus();
			}
		});

		// The checkout dirty-state indicator (orange/red/green) for the active pointer.
		if (Platform.isDesktop) {
			this.dirtyStatusEl = this.addStatusBarItem();
			this.registerEvent(this.app.workspace.on('active-leaf-change', () => { void this.updateDirtyStatus(); }));

			// Guard quit/close while a file is checked out (its cloud copy may be behind
			// the local edits). A native confirm; the richer in-app modal is deferred.
			this.registerDomEvent(window, 'beforeunload', (event: BeforeUnloadEvent) => {
				if (this.checkedOut.size > 0) {
					// Modern browsers/Electron show a generic prompt when the default is
					// prevented; the custom in-app dirty modal is the deferred refinement.
					event.preventDefault();
				}
			});
		}
	}

	onunload(): void {
		this.autoOffload?.dispose();
	}

	// Check out a pointer to edit it in the OS default app. Guarded.
	private async runCheckout(pointer: TFile): Promise<void> {
		if (!this.requireStorageReady()) {
			return;
		}
		this.logger.info('Checkout started.', { path: pointer.path });
		try {
			let result = await this.attachments.checkout(pointer);
			if (!result.ok && (result.lockState === 'held-by-other' || result.lockState === 'stale')) {
				// Advisory only: offer a forced checkout (the lock cannot be enforced).
				const force = await this.confirm('Force a checkout?', `${result.error ?? 'This file is checked out elsewhere.'} Force a checkout anyway?`, 'Force checkout');
				if (!force) {
					new Notice(result.error ?? 'This file is checked out on another device.');
					return;
				}
				result = await this.attachments.checkout(pointer, { force: true });
			}
			if (result.ok) {
				this.checkedOut.add(pointer.path);
				new Notice(`Checked out ${pointer.basename}. Edit it in the app that opened, then check it in to save a new version.`);
				void this.updateDirtyStatus();
			} else {
				const state = classifyError(result.error);
				new Notice(state.isAuth ? state.message : `Could not check out ${pointer.basename}: ${result.error ?? 'unknown error'}.`);
			}
		} catch (error) {
			new Notice(`Checkout of ${pointer.basename} failed. See the log for details.`);
			this.logger.error('Checkout threw.', { path: pointer.path, error: describeError(error) });
		}
	}

	// Check in a pointer: save the edited working copy back as a new version. Guarded.
	private async runCheckin(pointer: TFile): Promise<void> {
		if (!this.requireStorageReady()) {
			return;
		}
		new Notice(`Checking in ${pointer.basename}...`);
		this.logger.info('Checkin started.', { path: pointer.path });
		try {
			const result = await this.attachments.checkin(pointer);
			if (result.ok) {
				this.checkedOut.delete(pointer.path);
				if (result.kind === 'no-op') {
					new Notice(`${pointer.basename} was unchanged; checkout released.`);
				} else if (result.kind === 'conflict') {
					new Notice(`Checked in ${pointer.basename} as a new version. The cloud had changed meanwhile, so the previous version was kept as a conflict copy.`);
				} else {
					new Notice(`Checked in ${pointer.basename} as a new version.`);
				}
				void this.updateDirtyStatus();
			} else {
				const state = classifyError(result.error);
				new Notice(state.isAuth ? state.message : `Could not check in ${pointer.basename}: ${result.error ?? 'unknown error'}. Your edits are kept.`);
			}
		} catch (error) {
			new Notice(`Check-in of ${pointer.basename} failed. Your edits are kept. See the log for details.`);
			this.logger.error('Checkin threw.', { path: pointer.path, error: describeError(error) });
		}
	}

	// Discard a checkout: drop the working copy, no upload. Guarded + confirmed.
	private async runDiscardCheckout(pointer: TFile): Promise<void> {
		const ok = await this.confirm('Discard checkout?', `Discard your checked-out edits to ${pointer.basename}? The working copy is deleted and nothing is uploaded.`, 'Discard edits');
		if (!ok) {
			return;
		}
		try {
			const result = await this.attachments.discardCheckout(pointer);
			if (result.ok) {
				this.checkedOut.delete(pointer.path);
				new Notice(`Discarded the checkout of ${pointer.basename}.`);
				void this.updateDirtyStatus();
			} else {
				new Notice(`Could not discard the checkout: ${result.error ?? 'unknown error'}.`);
			}
		} catch (error) {
			new Notice(`Discarding the checkout of ${pointer.basename} failed. See the log for details.`);
			this.logger.error('Discard checkout threw.', { path: pointer.path, error: describeError(error) });
		}
	}

	// Update the status bar dirty indicator for the active pointer note.
	private async updateDirtyStatus(): Promise<void> {
		if (this.dirtyStatusEl === null) {
			return;
		}
		const file = this.app.workspace.getActiveFile();
		const frontmatter = file !== null && file.extension === 'md' ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
		if (file === null || frontmatter === undefined || !('la_version' in frontmatter)) {
			this.dirtyStatusEl.setText('');
			this.dirtyStatusEl.removeClass('linked-attachments-dirty-green', 'linked-attachments-dirty-orange', 'linked-attachments-dirty-red');
			return;
		}
		try {
			const state = await this.attachments.dirtyStateFor(file);
			const color = dirtyColor(state);
			this.dirtyStatusEl.setText(`Storage: ${dirtyLabel(state)}`);
			this.dirtyStatusEl.removeClass('linked-attachments-dirty-green', 'linked-attachments-dirty-orange', 'linked-attachments-dirty-red');
			this.dirtyStatusEl.addClass(`linked-attachments-dirty-${color}`);
		} catch (error) {
			this.dirtyStatusEl.setText('');
			this.logger.warn('Dirty status read failed.', { path: file.path, error: describeError(error) });
		}
	}

	// The active file if it is a pointer note (md with la_* frontmatter), else null.
	private activePointer(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		if (file === null || file.extension !== 'md') {
			return null;
		}
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return frontmatter !== undefined && 'la_version' in frontmatter ? file : null;
	}

	private pointerCopyState(file: TFile): string | undefined {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const state: unknown = frontmatter?.['la_copy_state'];
		return typeof state === 'string' ? state : undefined;
	}

	// A Promise-based confirmation modal (the browser confirm() is banned by lint).
	private confirm(title: string, body: string, cta: string): Promise<boolean> {
		return new Promise((resolve) => {
			new ConfirmModal(this.app, { title, body, cta, onResult: resolve }).open();
		});
	}

	private requireStorageReady(): boolean {
		if (this.settings.endpoint.length === 0 || this.settings.bucket.length === 0) {
			new Notice('Set the endpoint and bucket in settings first.');
			return false;
		}
		if (!this.credentials.hasCompleteCredentials()) {
			new Notice('Add your storage credentials in settings first.');
			return false;
		}
		return true;
	}

	// Open the batch dry-run preview + progress modal for a multi-file selection.
	private runBatchOffload(files: TFile[]): void {
		if (this.settings.endpoint.length === 0 || this.settings.bucket.length === 0) {
			new Notice('Set the endpoint and bucket in settings first.');
			return;
		}
		if (!this.credentials.hasCompleteCredentials()) {
			new Notice('Add your storage credentials in settings first.');
			return;
		}
		new BatchOffloadModal(this.app, this.attachments, files, (error) => {
			this.logger.error('Batch offload threw.', { error: describeError(error) });
		}).open();
	}

	// Apply the per-extension offload rules across every existing file in the vault
	// and offload the matches in one batch. This is the retroactive counterpart to
	// auto-offload (which only acts on files added going forward), sharing the exact
	// same policy via planVaultSweep, so a "scan now" catches precisely the files a
	// future add would. It reuses the batch dry-run preview + progress modal, so the
	// user sees every file and the total and nothing moves until they confirm.
	runVaultSweep(): void {
		if (!this.requireStorageReady()) {
			return;
		}
		const byPath = new Map<string, TFile>();
		const candidates: SweepFile[] = [];
		for (const file of this.app.vault.getFiles()) {
			byPath.set(file.path, file);
			candidates.push({ path: file.path, extension: file.extension, size: file.stat.size });
		}
		const plan = planVaultSweep(candidates, normalizeRules(this.settings.offloadRules));
		this.logger.info('Vault sweep planned.', {
			matched: plan.selected.length,
			skipped: plan.skipped,
			totalBytes: plan.totalBytes,
		});
		if (plan.selected.length === 0) {
			new Notice('No files in your vault match the offload rules. Add or adjust rules in settings.');
			return;
		}
		const targets = plan.selected
			.map((entry) => byPath.get(entry.path))
			.filter((file): file is TFile => file instanceof TFile);
		this.runBatchOffload(targets);
	}

	// Resume an interrupted offload from the session journal. Guarded.
	private async runResume(): Promise<void> {
		new Notice('Checking for interrupted offloads...');
		try {
			const result = await this.attachments.resumeInterrupted();
			if (result.journals === 0) {
				new Notice('No interrupted offload was found.');
			} else {
				new Notice(`Resumed ${result.resumed} file(s) from ${result.journals} session(s)${result.failed > 0 ? `, ${result.failed} still need attention` : ''}.`);
			}
			this.logger.info('Resume finished.', result);
		} catch (error) {
			new Notice('Resume failed. See the log for details.');
			this.logger.error('Resume threw.', { error: describeError(error) });
		}
	}

	// Copy a pointer's storage reference (bucket, key, honest size/format) to the
	// clipboard so the user can open the object in their own S3 app. This is the v1
	// mobile bridge - the plugin does not do in-app mobile transport.
	private async copyPointerReference(pointer: TFile): Promise<void> {
		try {
			const record = decodePointer(await this.app.vault.read(pointer)).record;
			await navigator.clipboard.writeText(formatPointerReference(record));
			new Notice('Storage reference copied. Open it in your S3 app.');
		} catch (error) {
			new Notice('Could not copy the storage reference. See the log for details.');
			this.logger.warn('Copy reference failed.', { path: pointer.path, error: describeError(error) });
		}
	}

	// Surface a pointer's trust badge (Verified / Found / Asserted) in a notice, so
	// the user always sees what was actually confirmed about the cloud copy.
	private async showPointerStatus(pointer: TFile): Promise<void> {
		try {
			const record = decodePointer(await this.app.vault.read(pointer)).record;
			new Notice(`${pointer.basename}: ${pointerTrustLine(record)}`);
		} catch (error) {
			new Notice('That note is not a storage pointer.');
			this.logger.warn('Pointer status read failed.', { path: pointer.path, error: describeError(error) });
		}
	}

	// Offload a file. First show a dry-run preview (B7) of where it will go; nothing
	// moves until the user confirms. Guarded so a failure computing the preview is a
	// notice + a logged error, never an unhandled rejection.
	private async runOffload(file: TFile): Promise<void> {
		if (this.settings.endpoint.length === 0 || this.settings.bucket.length === 0) {
			new Notice('Set the endpoint and bucket in settings first.');
			return;
		}
		if (!this.credentials.hasCompleteCredentials()) {
			new Notice('Add your storage credentials in settings first.');
			return;
		}
		try {
			const plan = await this.attachments.planOffload(file);
			new OffloadPreviewModal(this.app, plan, () => {
				void this.executeOffload(file);
			}).open();
		} catch (error) {
			new Notice(`Could not prepare the offload of ${file.name}. See the log for details.`);
			this.logger.error('Offload preview failed.', { path: file.path, error: describeError(error) });
		}
	}

	// Run the verified upload, then the local original goes to system trash
	// (recoverable). Never removes a file without a verified cloud copy.
	// Whether the active storage mode is fully configured: S3 modes need endpoint +
	// bucket + credentials; local-only needs a local root; paired needs both.
	private storageConfigured(): boolean {
		const s3Ready = this.settings.endpoint.length > 0 && this.settings.bucket.length > 0 && this.credentials.hasCompleteCredentials();
		const localReady = this.settings.localRoot.trim().length > 0;
		switch (this.settings.storageMode) {
			case 'local-only':
				return localReady;
			case 'local-s3':
				return s3Ready && localReady;
			default:
				return s3Ready;
		}
	}

	private async executeOffload(file: TFile): Promise<void> {
		new Notice(`Offloading ${file.name}...`);
		this.logger.info('Offload started.', { path: file.path });
		try {
			const result = await this.attachments.offload(file);
			if (result.ok) {
				new Notice(offloadOutcomeLine(file.name, result));
				this.logger.info('Offload finished.', { path: file.path, removed: result.removed, tier: result.record?.verificationTier });
			} else {
				// An auth failure gets the honest "stale keys" message, not a raw error.
				const state = classifyError(result.error);
				new Notice(state.isAuth ? state.message : offloadOutcomeLine(file.name, result));
				this.logger.warn('Offload did not complete.', { path: file.path, stage: result.reachedStage, error: result.error, authFailure: state.isAuth });
			}
		} catch (error) {
			new Notice(`Offload of ${file.name} failed. See the log for details.`);
			this.logger.error('Offload threw.', { path: file.path, error: describeError(error) });
		}
	}

	// Restore a pointer note: download, verify the bytes against the recorded hash,
	// write the file back, and remove the pointer. Guarded.
	private async runRestore(pointer: TFile): Promise<void> {
		if (this.settings.endpoint.length === 0 || this.settings.bucket.length === 0) {
			new Notice('Set the endpoint and bucket in settings first.');
			return;
		}
		if (!this.credentials.hasCompleteCredentials()) {
			new Notice('Add your storage credentials in settings first.');
			return;
		}
		new Notice(`Restoring from ${pointer.name}...`);
		this.logger.info('Restore started.', { path: pointer.path });
		try {
			const result = await this.attachments.restore(pointer);
			if (result.ok) {
				new Notice(`Restored ${result.restoredPath ?? 'the file'}.`);
				this.logger.info('Restore finished.', { pointer: pointer.path, restoredPath: result.restoredPath });
			} else {
				const state = classifyError(result.error);
				new Notice(state.isAuth ? state.message : `Restore did not complete: ${result.error ?? 'unknown error'}.`);
				this.logger.warn('Restore did not complete.', { pointer: pointer.path, error: result.error, authFailure: state.isAuth });
			}
		} catch (error) {
			const state = classifyError(error);
			new Notice(state.isAuth ? state.message : `Restore from ${pointer.name} failed. See the log for details.`);
			this.logger.error('Restore threw.', { pointer: pointer.path, error: describeError(error), authFailure: state.isAuth });
		}
	}

	async loadSettings(): Promise<void> {
		// The legacy fields (autoOffloadAllowlist / autoOffloadSizeThresholdMb) are no
		// longer on the settings interface but may exist in an older data.json; type
		// them as optional here so the one-time migration below can read them.
		const raw = (await this.loadData()) as
			| (Partial<LinkedAttachmentsSettings> & { autoOffloadAllowlist?: string; autoOffloadSizeThresholdMb?: number })
			| null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);

		// Map a saved old-default secret name to its current short name.
		const renamedAccess = RENAMED_SECRET_IDS[this.settings.accessKeyIdSecretName];
		if (renamedAccess !== undefined) {
			this.settings.accessKeyIdSecretName = renamedAccess;
		}
		const renamedSecret = RENAMED_SECRET_IDS[this.settings.secretAccessKeySecretName];
		if (renamedSecret !== undefined) {
			this.settings.secretAccessKeySecretName = renamedSecret;
		}

		// A data.json saved by an earlier build may carry empty secret names.
		// Coalesce them back to the default names so the picker and the credential
		// reads always have a canonical name to use.
		if (this.settings.accessKeyIdSecretName.length === 0) {
			this.settings.accessKeyIdSecretName = DEFAULT_ACCESS_KEY_SECRET_ID;
		}
		if (this.settings.secretAccessKeySecretName.length === 0) {
			this.settings.secretAccessKeySecretName = DEFAULT_SECRET_KEY_SECRET_ID;
		}

		// Migrate the pre-2.1 auto-offload model (one comma allowlist + one global MB
		// threshold) into the per-extension rule table, once. An older data.json has
		// no offloadRules, so Object.assign above left the DEFAULT_SETTINGS rules in
		// place; rebuild them from the saved legacy fields instead so the upgrade
		// qualifies exactly the files it did before (each old type -> an over-size
		// rule at the old global threshold). A fresh install keeps the defaults.
		if (raw !== null && raw.offloadRules === undefined && typeof raw.autoOffloadAllowlist === 'string') {
			const threshold = typeof raw.autoOffloadSizeThresholdMb === 'number' ? raw.autoOffloadSizeThresholdMb : 5;
			this.settings.offloadRules = rulesFromLegacy(raw.autoOffloadAllowlist, threshold);
		}
		// Normalize whichever rule set we ended up with (dedupe by type, clamp
		// thresholds), so persisted or migrated data is always in canonical shape.
		this.settings.offloadRules = normalizeRules(this.settings.offloadRules);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
