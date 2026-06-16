import { App, ButtonComponent, Notice, PluginSettingTab, Setting, SettingDefinitionItem, SecretComponent } from 'obsidian';
import type LinkedAttachmentsPlugin from './main';
import { describeError } from './credentials';
import { DEFAULT_ACCESS_KEY_SECRET_ID, DEFAULT_SECRET_KEY_SECRET_ID } from './settings';
import { testConnection } from './s3-connection';
import { runRemoteTransportProbe } from './probe-remote-transport';

export class LinkedAttachmentsSettingTab extends PluginSettingTab {
	plugin: LinkedAttachmentsPlugin;
	private statusEl: HTMLElement | null = null;
	private testButton: ButtonComponent | null = null;
	private probeStatusEl: HTMLElement | null = null;
	private transportButton: ButtonComponent | null = null;

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
				heading: 'Diagnostics',
				items: [
					{
						name: 'Debug logging',
						desc: `Also write debug-level detail to the log. Every bucket interaction, warning, and error is logged regardless. Log file: ${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}/audit.jsonl`,
						control: { type: 'toggle', key: 'debugLogging' },
					},
					{
						name: 'Remote transport probe',
						desc: 'Run PUT, HEAD, GET, range-GET, list, and DELETE against your bucket to validate transport, checksums, and pagination (AC-G1/G2/G3). Writes and deletes temporary objects under a linked-attachments-probe/ prefix; results go to the log.',
						searchable: false,
						render: (setting: Setting) => { this.renderTransportProbeRow(setting); },
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

	private setProbeStatus(text: string, kind: 'ok' | 'error' | 'neutral'): void {
		this.applyStatus(this.probeStatusEl, text, kind);
	}

	private applyStatus(el: HTMLElement | null, text: string, kind: 'ok' | 'error' | 'neutral'): void {
		if (el === null) {
			return;
		}
		el.setText(text);
		el.toggleClass('linked-attachments-secret-status-ok', kind === 'ok');
		el.toggleClass('linked-attachments-secret-status-error', kind === 'error');
	}

	private renderTransportProbeRow(setting: Setting): void {
		setting.addButton((btn) => {
			this.transportButton = btn;
			btn.setButtonText('Run transport probe').onClick(() => { void this.runTransportProbe(); });
		});
		this.probeStatusEl = setting.descEl.createDiv({ cls: 'linked-attachments-secret-status' });
	}

	// AC-G1/G2/G3: PUT/HEAD/GET/range/list/DELETE against the bucket. The live
	// result and per-op detail go to the audit log; a summary shows here. Guarded so
	// a failure surfaces as a status line rather than an unhandled rejection.
	private async runTransportProbe(): Promise<void> {
		const creds = this.plugin.credentials.getCredentials();
		if (creds === null) {
			this.setProbeStatus('Link both credentials first.', 'error');
			return;
		}
		const s = this.plugin.settings;
		if (s.endpoint.length === 0 || s.bucket.length === 0) {
			this.setProbeStatus('Set the endpoint and bucket above first.', 'error');
			return;
		}

		this.transportButton?.setDisabled(true);
		this.setProbeStatus('Running transport probe...', 'neutral');
		const runId = String(Date.now());
		this.plugin.logger.info('Remote transport probe started.', { runId, bucket: s.bucket });
		try {
			const result = await runRemoteTransportProbe(
				{ config: { endpoint: s.endpoint, region: s.region, bucket: s.bucket, addressingStyle: s.addressingStyle }, creds, audit: this.plugin.logger },
				runId,
			);
			const passed = result.checks.filter((c) => c.pass).length;
			const lines = result.checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`).concat(result.notes);
			new Notice(`Transport probe ${result.ok ? 'PASS' : 'FAIL'}\n${lines.join('\n')}`, 20000);
			this.setProbeStatus(`${result.ok ? 'PASS' : 'FAIL'} - ${passed}/${result.checks.length} checks. See the log for per-operation detail.`, result.ok ? 'ok' : 'error');
			this.plugin.logger.info('Remote transport probe finished.', { runId, ok: result.ok, checks: result.checks, notes: result.notes });
		} catch (error) {
			this.setProbeStatus(`Transport probe failed: ${describeError(error)}`, 'error');
			this.plugin.logger.error('Remote transport probe threw.', { runId, error: describeError(error) });
		} finally {
			this.transportButton?.setDisabled(false);
		}
	}
}
