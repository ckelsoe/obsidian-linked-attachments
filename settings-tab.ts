import { App, PluginSettingTab, Setting, SettingDefinitionItem, SecretComponent } from 'obsidian';
import type LinkedAttachmentsPlugin from './main';
import { SecretStore } from './credentials';

export class LinkedAttachmentsSettingTab extends PluginSettingTab {
	plugin: LinkedAttachmentsPlugin;
	private statusEl: HTMLElement | null = null;

	constructor(app: App, plugin: LinkedAttachmentsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				heading: 'Connection',
				items: [
					{
						name: 'Endpoint',
						desc: 'Base URL of your S3-compatible service, e.g. https://<account>.r2.cloudflarestorage.com or https://s3.us-east-1.amazonaws.com. Not a secret.',
						control: { type: 'text', key: 'endpoint', placeholder: 'https://...' },
					},
					{
						name: 'Region',
						desc: 'Bucket region, e.g. us-east-1. Use auto for Cloudflare R2. Not a secret.',
						control: { type: 'text', key: 'region', placeholder: 'us-east-1' },
					},
					{
						name: 'Bucket',
						desc: 'Name of the bucket that holds your offloaded files. Not a secret.',
						control: { type: 'text', key: 'bucket', placeholder: 'my-vault-attachments' },
					},
					{
						name: 'Addressing style',
						desc: 'How the bucket is placed in the request URL. Most providers use virtual-hosted; MinIO and some self-hosted setups need path.',
						control: {
							type: 'dropdown',
							key: 'addressingStyle',
							options: {
								'virtual-hosted': 'Virtual-hosted - bucket.endpoint',
								'path': 'Path - endpoint/bucket',
							},
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Credentials',
				items: [
					{
						name: 'Access key',
						desc: 'Create or select the secret holding your S3 access key ID. Enter the value in the secure picker; only the secret name is saved to data.json. Use a key scoped to only this bucket.',
						searchable: false,
						render: (setting: Setting) => {
							setting.addComponent((el) =>
								new SecretComponent(this.app, el)
									.setValue(this.plugin.settings.accessKeyIdSecretName)
									.onChange(async (id) => {
										this.plugin.settings.accessKeyIdSecretName = id;
										await this.plugin.saveSettings();
										this.refreshCredentialStatus();
									}),
							);
						},
					},
					{
						name: 'Secret access key',
						desc: 'Create or select the secret holding your S3 secret access key. Enter the value in the secure picker; only the secret name is saved to data.json.',
						searchable: false,
						render: (setting: Setting) => {
							setting.addComponent((el) =>
								new SecretComponent(this.app, el)
									.setValue(this.plugin.settings.secretAccessKeySecretName)
									.onChange(async (id) => {
										this.plugin.settings.secretAccessKeySecretName = id;
										await this.plugin.saveSettings();
										this.refreshCredentialStatus();
									}),
							);
						},
					},
					{
						name: 'Status',
						desc: 'Whether secret storage is available on this platform and whether both credentials are linked.',
						searchable: false,
						render: (setting: Setting) => { this.renderStatusRow(setting); },
					},
				],
			},
		];
	}

	// Routes declarative control reads/writes to the plugin's own settings store so
	// a change persists through saveSettings().
	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
	}

	private renderStatusRow(setting: Setting): void {
		this.statusEl = setting.descEl.createDiv({ cls: 'linked-attachments-secret-status' });
		this.refreshCredentialStatus();
	}

	// Read-only check: is the secret storage API present on this platform, and are
	// both credentials linked. It performs NO writes, so it never creates a stored
	// secret. (The desktop setSecret/getSecret round-trip, AC-G6, was confirmed
	// once; the API has no remove method, so a write-probe would leave an
	// un-deletable entry behind.)
	private secretStorageAvailable(): boolean {
		const raw: unknown = this.app.secretStorage;
		return (
			typeof raw === 'object' &&
			raw !== null &&
			typeof (raw as SecretStore).getSecret === 'function'
		);
	}

	private refreshCredentialStatus(): void {
		if (this.statusEl === null) {
			return;
		}
		if (!this.secretStorageAvailable()) {
			this.setStatus('Secret storage is not available on this platform.', 'error');
			return;
		}
		const ready = this.plugin.credentials.hasCompleteCredentials();
		this.setStatus(
			ready
				? 'Secret storage available. Both credentials are linked on this device.'
				: 'Secret storage available. Link both an access key and a secret access key above.',
			ready ? 'ok' : 'neutral',
		);
	}

	private setStatus(text: string, kind: 'ok' | 'error' | 'neutral'): void {
		if (this.statusEl === null) {
			return;
		}
		this.statusEl.setText(text);
		this.statusEl.toggleClass('linked-attachments-secret-status-ok', kind === 'ok');
		this.statusEl.toggleClass('linked-attachments-secret-status-error', kind === 'error');
	}
}
