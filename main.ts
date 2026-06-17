import { Notice, Plugin, TFile } from 'obsidian';
import {
	LinkedAttachmentsSettings,
	DEFAULT_SETTINGS,
	DEFAULT_ACCESS_KEY_SECRET_ID,
	DEFAULT_SECRET_KEY_SECRET_ID,
} from './settings';
import { CredentialStore, describeError } from './credentials';
import { LinkedAttachmentsSettingTab } from './settings-tab';
import { Logger } from './logger';
import { AttachmentService } from './src/service/attachment-service';
import { OffloadPreviewModal } from './src/ui/offload-preview-modal';
import { TrustRehearsalModal } from './src/ui/trust-rehearsal-modal';
import { BatchOffloadModal } from './src/ui/batch-offload-modal';
import { AdoptModal } from './src/ui/adopt-modal';
import { offloadOutcomeLine, pointerTrustLine } from './src/ui/trust-summary';
import { decodePointer } from './src/pointer/codec';

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
					new TrustRehearsalModal(this.app, this.attachments, (error) => {
						this.logger.error('Trust rehearsal threw.', { error: describeError(error) });
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
	private async executeOffload(file: TFile): Promise<void> {
		new Notice(`Offloading ${file.name}...`);
		this.logger.info('Offload started.', { path: file.path });
		try {
			const result = await this.attachments.offload(file);
			new Notice(offloadOutcomeLine(file.name, result));
			if (result.ok) {
				this.logger.info('Offload finished.', { path: file.path, removed: result.removed, tier: result.record?.verificationTier });
			} else {
				this.logger.warn('Offload did not complete.', { path: file.path, stage: result.reachedStage, error: result.error });
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
				new Notice(`Restore did not complete: ${result.error ?? 'unknown error'}.`);
				this.logger.warn('Restore did not complete.', { pointer: pointer.path, error: result.error });
			}
		} catch (error) {
			new Notice(`Restore from ${pointer.name} failed. See the log for details.`);
			this.logger.error('Restore threw.', { pointer: pointer.path, error: describeError(error) });
		}
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<LinkedAttachmentsSettings> | null;
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
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
