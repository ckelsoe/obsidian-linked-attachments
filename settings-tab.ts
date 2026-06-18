import { App, ButtonComponent, Notice, PluginSettingTab, Setting, SettingDefinitionItem, SecretComponent } from 'obsidian';
import type LinkedAttachmentsPlugin from './main';
import { describeError } from './credentials';
import { DEFAULT_ACCESS_KEY_SECRET_ID, DEFAULT_SECRET_KEY_SECRET_ID } from './settings';
import { testConnection } from './s3-connection';
import { TrustRehearsalModal } from './src/ui/trust-rehearsal-modal';

export class LinkedAttachmentsSettingTab extends PluginSettingTab {
	plugin: LinkedAttachmentsPlugin;
	private statusEl: HTMLElement | null = null;
	private testButton: ButtonComponent | null = null;

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
						desc: `Click Link, then Add secret, and name it "${DEFAULT_ACCESS_KEY_SECRET_ID}". Paste your S3 access key ID as the value. Only the secret name is saved to data.json; the value stays in the device secret store. Use a key scoped to only this bucket.`,
						searchable: false,
						render: (setting: Setting) => {
							setting.addComponent((el) =>
								new SecretComponent(this.app, el)
									.setValue(this.plugin.settings.accessKeyIdSecretName)
									.onChange(async (id) => {
										this.plugin.settings.accessKeyIdSecretName = id;
										await this.plugin.saveSettings();
										this.refreshCredentialHint();
									}),
							);
						},
					},
					{
						name: 'Secret access key',
						desc: `Click Link, then Add secret, and name it "${DEFAULT_SECRET_KEY_SECRET_ID}". Paste your S3 secret access key as the value. Only the secret name is saved to data.json; the value stays in the device secret store.`,
						searchable: false,
						render: (setting: Setting) => {
							setting.addComponent((el) =>
								new SecretComponent(this.app, el)
									.setValue(this.plugin.settings.secretAccessKeySecretName)
									.onChange(async (id) => {
										this.plugin.settings.secretAccessKeySecretName = id;
										await this.plugin.saveSettings();
										this.refreshCredentialHint();
									}),
							);
						},
					},
					{
						name: 'Connection',
						desc: 'Verify the endpoint, region, bucket, and credentials by listing the bucket.',
						searchable: false,
						render: (setting: Setting) => { this.renderConnectionTestRow(setting); },
					},
				],
			},
			{
				type: 'group',
				heading: 'Round-trip rehearsal',
				items: [
					{
						name: 'Rehearse a round-trip',
						desc: 'Before you trust a real file, test your bucket end to end on a throwaway object: uploaded, verified byte-for-byte, retrieved, and matched. Nothing in your vault is touched.',
						searchable: false,
						render: (setting: Setting) => {
							setting.addButton((btn) =>
								btn.setButtonText('Rehearse').setCta().onClick(() => {
									const ready = this.plugin.settings.endpoint.length > 0 && this.plugin.settings.bucket.length > 0 && this.plugin.credentials.hasCompleteCredentials();
									if (!ready) {
										new Notice('Set the endpoint, bucket, and credentials first.');
										return;
									}
									new TrustRehearsalModal(this.app, this.plugin.attachments, (error) => {
										this.plugin.logger.error('Trust rehearsal threw.', { error: describeError(error) });
									}).open();
								}),
							);
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Automatic offload',
				items: [
					{
						name: 'Offload large new files automatically',
						desc: 'When a new file of an allowed type is larger than the threshold, offer to offload it so the heavy bytes never try to sync. Off by default.',
						control: { type: 'toggle', key: 'autoOffloadEnabled' },
					},
					{
						name: 'File types',
						desc: 'Comma-separated extensions to consider, e.g. pdf, epub, mp3, zip. Actively-edited types are best left out.',
						control: { type: 'text', key: 'autoOffloadAllowlist', placeholder: 'pdf, epub, mp3, zip' },
					},
					{
						name: 'Size threshold in MB',
						desc: 'Only files at least this large are offered. Small files sync fine and are left alone.',
						control: { type: 'number', key: 'autoOffloadSizeThresholdMb' },
					},
					{
						name: 'Trigger',
						desc: 'Prompt asks you on every qualifying add. Offload when idle waits until the file has been untouched for the idle window (desktop only; mobile always prompts).',
						control: {
							type: 'dropdown',
							key: 'autoOffloadTriggerMode',
							options: {
								'prompt': 'Prompt me on add',
								'idle-debounce': 'Offload when idle',
							},
						},
					},
					{
						name: 'Idle window in minutes',
						desc: 'Used only when the trigger is offload when idle: how long a file must be untouched before it is offloaded.',
						control: { type: 'number', key: 'autoOffloadIdleMinutes' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Diagnostics',
				items: [
					{
						name: 'Debug logging',
						desc: `Also write debug-level detail to the log. Every bucket interaction, warning, and error is logged regardless. Log file: ${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}/audit.jsonl`,
						control: { type: 'toggle', key: 'debugLogging' },
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

	private renderConnectionTestRow(setting: Setting): void {
		setting.addButton((btn) => {
			this.testButton = btn;
			btn.setButtonText('Test connection').onClick(() => { void this.runConnectionTest(); });
		});
		this.statusEl = setting.descEl.createDiv({ cls: 'linked-attachments-secret-status' });
		this.refreshCredentialHint();
	}

	// Pre-test hint shown before the user presses the button or links the keys.
	private refreshCredentialHint(): void {
		if (this.statusEl === null) {
			return;
		}
		const ready = this.plugin.credentials.hasCompleteCredentials();
		this.setStatus(
			ready
				? 'Both credentials linked. Press Test connection to verify against your bucket.'
				: 'Link both an access key and a secret access key above.',
			'neutral',
		);
	}

	// Signs and sends a ListObjectsV2 against the bucket; the live result is the
	// authoritative validation of the credentials and configuration. Guarded so a
	// failure shows as a status line rather than an unhandled rejection.
	private async runConnectionTest(): Promise<void> {
		const creds = this.plugin.credentials.getCredentials();
		if (creds === null) {
			this.setStatus('Link both credentials first.', 'error');
			return;
		}
		const s = this.plugin.settings;
		if (s.endpoint.length === 0 || s.bucket.length === 0) {
			this.setStatus('Set the endpoint and bucket above first.', 'error');
			return;
		}

		this.testButton?.setDisabled(true);
		this.setStatus('Testing connection...', 'neutral');
		this.plugin.logger.info('Connection test started.', { bucket: s.bucket, addressingStyle: s.addressingStyle });
		try {
			const result = await testConnection(
				{ endpoint: s.endpoint, region: s.region, bucket: s.bucket, addressingStyle: s.addressingStyle },
				creds,
				this.plugin.logger,
			);
			this.setStatus(result.detail, result.ok ? 'ok' : 'error');
			this.plugin.logger.info('Connection test finished.', { ok: result.ok, detail: result.detail });
		} catch (error) {
			this.setStatus(`Connection test failed: ${describeError(error)}`, 'error');
		} finally {
			this.testButton?.setDisabled(false);
		}
	}

	private setStatus(text: string, kind: 'ok' | 'error' | 'neutral'): void {
		this.applyStatus(this.statusEl, text, kind);
	}

	private applyStatus(el: HTMLElement | null, text: string, kind: 'ok' | 'error' | 'neutral'): void {
		if (el === null) {
			return;
		}
		el.setText(text);
		el.toggleClass('linked-attachments-secret-status-ok', kind === 'ok');
		el.toggleClass('linked-attachments-secret-status-error', kind === 'error');
	}
}
