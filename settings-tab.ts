import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem, SecretComponent } from 'obsidian';
import type LinkedAttachmentsPlugin from './main';
import { runSecretStorageProbe, SecretStore } from './credentials';

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
						desc: 'The S3 access key ID. Held in the device secret store, never in data.json. Use a key scoped to only this bucket.',
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
						desc: 'The S3 secret access key. Held in the device secret store, never in data.json.',
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
						name: 'Secret storage check',
						desc: 'Confirm this device can store and read back a secret, and whether both credentials are present.',
						searchable: false,
						render: (setting: Setting) => { this.renderSecretStorageRow(setting); },
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

	private renderSecretStorageRow(setting: Setting): void {
		setting.addButton((btn) =>
			btn
				.setButtonText('Check secret storage')
				.onClick(() => { this.runProbe(); }),
		);
		this.statusEl = setting.descEl.createDiv({ cls: 'linked-attachments-secret-status' });
		this.refreshCredentialStatus();
	}

	// AC-G6 (desktop): prove setSecret -> getSecret round-trips on this platform,
	// and record whether the API is even present. Mobile G6 is a separate later
	// device probe; this reports only what the running platform supports.
	private runProbe(): void {
		const raw: unknown = this.app.secretStorage;
		const present =
			typeof raw === 'object' &&
			raw !== null &&
			typeof (raw as SecretStore).setSecret === 'function';

		if (!present) {
			const detail = 'Secret storage API is not available on this platform.';
			new Notice(`Linked Attachments: ${detail}`);
			this.setStatus(detail, 'error');
			return;
		}

		const nonce = `probe-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
		const result = runSecretStorageProbe(this.app.secretStorage, nonce);
		new Notice(`Linked Attachments: ${result.detail}`);
		this.setStatus(result.detail, result.roundTripOk ? 'ok' : 'error');
	}

	private refreshCredentialStatus(): void {
		if (this.statusEl === null) {
			return;
		}
		const ready = this.plugin.credentials.hasCompleteCredentials();
		this.setStatus(
			ready
				? 'Both credentials are stored on this device.'
				: 'Credentials incomplete: enter both an access key and a secret access key above.',
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
