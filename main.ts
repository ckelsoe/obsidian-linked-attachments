import { Plugin } from 'obsidian';
import { LinkedAttachmentsSettings, DEFAULT_SETTINGS } from './settings';
import { CredentialStore } from './credentials';
import { LinkedAttachmentsSettingTab } from './settings-tab';

// Plugin entry point. Per the workspace code-structure rules this class is wiring
// only: lifecycle, settings persistence, and constructing the services. The
// credential logic lives in CredentialStore; the UI lives in the settings tab.
export default class LinkedAttachmentsPlugin extends Plugin {
	settings!: LinkedAttachmentsSettings;
	credentials!: CredentialStore;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Obsidian's SecretStorage is assignable to our structural SecretStore. The
		// store reads the secret NAMES from live settings via a getter, so changing
		// a name in the UI takes effect with no reconstruction.
		this.credentials = new CredentialStore(this.app.secretStorage, () => ({
			accessKeyIdSecretName: this.settings.accessKeyIdSecretName,
			secretAccessKeySecretName: this.settings.secretAccessKeySecretName,
		}));

		this.addSettingTab(new LinkedAttachmentsSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<LinkedAttachmentsSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
