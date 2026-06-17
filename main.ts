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

		// A right-click "Offload to storage" affordance on a non-markdown file.
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile) || file.extension === 'md') {
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

	}

	// Offload a file: verified upload, then the local original goes to system trash
	// (recoverable). Guarded so any failure is a notice + a logged error, never an
	// unhandled rejection, and never a removed file without a verified cloud copy.
	private async runOffload(file: TFile): Promise<void> {
		if (this.settings.endpoint.length === 0 || this.settings.bucket.length === 0) {
			new Notice('Set the endpoint and bucket in settings first.');
			return;
		}
		if (!this.credentials.hasCompleteCredentials()) {
			new Notice('Add your storage credentials in settings first.');
			return;
		}
		new Notice(`Offloading ${file.name}...`);
		this.logger.info('Offload started.', { path: file.path });
		try {
			const result = await this.attachments.offload(file);
			if (result.ok) {
				new Notice(result.removed ? `Offloaded ${file.name}. The local file was moved to trash.` : `Offloaded ${file.name}. The local file was kept (not yet at the delete-gate tier).`);
				this.logger.info('Offload finished.', { path: file.path, removed: result.removed, tier: result.record?.verificationTier });
			} else {
				new Notice(`Offload of ${file.name} did not complete: ${result.error ?? 'unknown error'}. Your file was not removed.`);
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
