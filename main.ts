import { Notice, Plugin } from 'obsidian';
import {
	LinkedAttachmentsSettings,
	DEFAULT_SETTINGS,
	DEFAULT_ACCESS_KEY_SECRET_ID,
	DEFAULT_SECRET_KEY_SECRET_ID,
} from './settings';
import { CredentialStore, describeError } from './credentials';
import { LinkedAttachmentsSettingTab } from './settings-tab';
import { runPointerRoundTripProbe } from './pointer-roundtrip-probe';
import { Logger } from './logger';

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

		// AC-G4 probe. Spike scaffolding: runs the pointer round-trip oracle in a
		// scratch folder and reports the verdict. Removed when the spike closes.
		this.addCommand({
			id: 'probe-pointer-round-trip',
			name: 'Probe pointer round trip',
			callback: () => { void this.runPointerProbe(); },
		});
	}

	// Guarded so a probe failure surfaces as a notice and a console error rather
	// than an unhandled rejection.
	private async runPointerProbe(): Promise<void> {
		const runId = String(Date.now());
		this.logger.info('Pointer round-trip probe started.', { runId });
		try {
			const result = await runPointerRoundTripProbe(this.app, runId);
			const lines = result.checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`).concat(result.notes);
			new Notice(`AC-G4 ${result.ok ? 'PASS' : 'FAIL'}\n${lines.join('\n')}`, 15000);
			this.logger.info('Pointer round-trip probe finished.', { runId, ok: result.ok, checks: result.checks, notes: result.notes });
		} catch (error) {
			new Notice('Pointer round-trip probe failed. See the log for details.');
			this.logger.error('Pointer round-trip probe threw.', { error: describeError(error) });
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
