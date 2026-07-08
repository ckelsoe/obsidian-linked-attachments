import { App, ButtonComponent, Notice, PluginSettingTab, Setting, SettingDefinitionItem, SettingGroupItem, SecretComponent } from 'obsidian';
import type LinkedAttachmentsPlugin from './main';
import { describeError } from './credentials';
import { DEFAULT_ACCESS_KEY_SECRET_ID, DEFAULT_SECRET_KEY_SECRET_ID } from './settings';
import { activeMachine, localMachineView, MachineListView, selectActiveRoot } from './src/storage/local-root';
import { resolveLocalRoot } from './src/storage/local-backend';
import { testConnection } from './s3-connection';
import { TrustRehearsalModal } from './src/ui/trust-rehearsal-modal';
import { LogViewModal } from './src/ui/log-view-modal';
import { OffloadRuleMode } from './src/offload/offload-rules';

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
				heading: 'Storage',
				items: [
					{
						name: 'Storage mode',
						desc: 'Where offloaded files are written. S3 only uses your bucket. Local only moves files to a folder outside the vault (a synced OneDrive, Dropbox, or NAS path). Local and S3 writes both, reading from the local copy and keeping S3 as an off-machine backup.',
						control: {
							type: 'dropdown',
							key: 'storageMode',
							options: {
								's3-only': 'S3 only',
								'local-only': 'Local only',
								'local-s3': 'Local and S3 (paired)',
							},
						},
					},
					{
						name: 'Local folders per machine',
						desc: 'Where the local and paired modes write, resolved per machine. Click Add this machine, then Browse to the offload folder on this machine. If you sync settings across machines, each one adds its own row and reads its own folder, so two machines with different drive letters both work. The bytes only appear on a machine after its sync client (OneDrive, Dropbox, and so on) downloads them, and the pointer note must have synced too, so a just-added file can lag on a second machine.',
						searchable: false,
						render: (setting: Setting) => { this.renderLocalMachineRows(setting); },
					},
				],
			},
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
				heading: 'Backfill existing pointers',
				items: this.backfillItems(),
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
									new TrustRehearsalModal(this.app, this.plugin.attachments, this.plugin.logger, (error) => {
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
				heading: 'File type rules',
				items: [
					{
						name: 'Types to offload',
						desc: 'Each file type is offloaded either always (any size) or only when larger than its own size in MB. A type that is not listed here is never offloaded. Turn a row off with its checkbox to keep the rule configured without offloading those files, for example while testing. These rules drive both automatic offload of new files and the scan below.',
						searchable: false,
						render: (setting: Setting) => { this.renderRuleTable(setting); },
					},
					{
						name: 'Scan the whole vault now',
						desc: 'Apply these rules to every file already in your vault and offload the matches in one batch. You get a preview of every file and the total before anything moves.',
						searchable: false,
						render: (setting: Setting) => {
							setting.addButton((btn) =>
								btn.setButtonText('Scan and offload').onClick(() => {
									this.plugin.runVaultSweep();
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
						desc: 'When a new file matching a rule above is added, offer to offload it so the heavy bytes never try to sync. Off by default.',
						control: { type: 'toggle', key: 'autoOffloadEnabled' },
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
					{
						name: 'View log',
						desc: 'Open the recent activity log and copy it to include in a bug report.',
						searchable: false,
						render: (setting: Setting) => {
							setting.addButton((btn) =>
								btn.setButtonText('View log').onClick(() => {
									new LogViewModal(this.app, () => this.plugin.logger.readRecent()).open();
								}),
							);
						},
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
		// The backfill group's buttons are derived from storageMode, so a mode change
		// adds or removes items. update() re-runs getSettingDefinitions() and rebuilds
		// (refreshDomState() only re-evaluates predicates, not structure).
		if (key === 'storageMode') {
			this.update();
		}
	}

	// The per-extension rule table. A composite, variable-length control, so it is a
	// custom render that saves itself (the declarative API cannot auto-bind it) and
	// is laid out full-width below the title/description (the workspace stacked-row
	// convention for long controls). Rows are managed imperatively: text/dropdown/
	// number edits update the model in place and persist; add/remove redraw the rows.
	private renderRuleTable(setting: Setting): void {
		setting.settingEl.addClass('linked-attachments-rule-setting');
		const table = setting.settingEl.createDiv({ cls: 'linked-attachments-rule-table' });
		this.drawRuleRows(table);
	}

	private drawRuleRows(table: HTMLElement): void {
		table.empty();
		const rules = this.plugin.settings.offloadRules;
		rules.forEach((rule, index) => {
			const row = table.createDiv({ cls: 'linked-attachments-rule-row' });

			// A disabled rule stays configured but offloads nothing; the row dims so
			// its paused state is visible at a glance.
			const syncEnabledState = (): void => {
				row.toggleClass('linked-attachments-rule-disabled', rule.enabled === false);
			};

			const toggle = row.createEl('input', { cls: 'linked-attachments-rule-enabled', type: 'checkbox' });
			toggle.checked = rule.enabled !== false;
			toggle.setAttribute('aria-label', 'Enable this rule');
			toggle.addEventListener('change', () => {
				rule.enabled = toggle.checked;
				syncEnabledState();
				void this.plugin.saveSettings();
			});

			const ext = row.createEl('input', { cls: 'linked-attachments-rule-ext', type: 'text' });
			ext.value = rule.extension;
			ext.placeholder = 'Extension';
			ext.addEventListener('change', () => {
				rule.extension = ext.value;
				void this.plugin.saveSettings();
			});

			const mode = row.createEl('select', { cls: 'dropdown linked-attachments-rule-mode' });
			mode.createEl('option', { value: 'always', text: 'Always offload' });
			mode.createEl('option', { value: 'over-size', text: 'Offload when larger than' });
			mode.value = rule.mode;

			const sizeWrap = row.createDiv({ cls: 'linked-attachments-rule-size' });
			const mb = sizeWrap.createEl('input', { cls: 'linked-attachments-rule-mb', type: 'number' });
			mb.value = String(rule.thresholdMb);
			mb.min = '0';
			sizeWrap.createSpan({ cls: 'linked-attachments-rule-unit', text: 'MB' });

			// 'always' rules have no threshold, so the MB field is hidden for them.
			const syncSizeVisibility = (): void => {
				sizeWrap.toggleClass('linked-attachments-hidden', rule.mode !== 'over-size');
			};
			syncSizeVisibility();

			mode.addEventListener('change', () => {
				rule.mode = mode.value as OffloadRuleMode;
				syncSizeVisibility();
				void this.plugin.saveSettings();
			});
			mb.addEventListener('change', () => {
				rule.thresholdMb = Math.max(0, Number(mb.value) || 0);
				void this.plugin.saveSettings();
			});

			const remove = row.createEl('button', { cls: 'linked-attachments-rule-remove', text: 'Remove' });
			remove.setAttribute('aria-label', `Remove the ${rule.extension || 'blank'} rule`);
			remove.addEventListener('click', () => {
				this.plugin.settings.offloadRules.splice(index, 1);
				void this.plugin.saveSettings();
				this.drawRuleRows(table);
			});

			syncEnabledState();
		});

		const add = table.createEl('button', { cls: 'linked-attachments-rule-add', text: 'Add file type' });
		add.addEventListener('click', () => {
			this.plugin.settings.offloadRules.push({ extension: '', mode: 'over-size', thresholdMb: 5, enabled: true });
			void this.plugin.saveSettings();
			this.drawRuleRows(table);
		});
	}

	// The cross-machine local-root control (2026-07-07). A composite, variable-length
	// control, so it renders full-width below the title/description (the workspace
	// stacked-row convention) and self-persists. It shows one row per machine
	// (hostname + that machine's offload folder), with this machine highlighted and
	// given a Browse button, an Add this machine button that pre-fills the current
	// hostname, and a banner showing what this machine resolves to right now. A
	// data.json synced across machines accumulates one row per machine, and each
	// machine reads its own by matching its hostname.
	private renderLocalMachineRows(setting: Setting): void {
		setting.settingEl.addClass('linked-attachments-local-setting');
		const wrap = setting.settingEl.createDiv({ cls: 'linked-attachments-local' });
		const thisMachine = activeMachine();
		const machines = (): typeof this.plugin.settings.localAttachment.machines => this.plugin.settings.localAttachment.machines;

		const banner = wrap.createDiv({ cls: 'linked-attachments-local-banner' });
		const table = wrap.createDiv({ cls: 'linked-attachments-local-table' });
		const add = wrap.createEl('button', { text: 'Add this machine', cls: 'linked-attachments-local-add' });

		// One pure view model drives banner text, the active row, and the Add state, so
		// the rules live in one tested place (localMachineView) rather than inline.
		const currentView = (): MachineListView =>
			localMachineView(machines(), thisMachine, resolveLocalRoot(selectActiveRoot(this.plugin.settings)));

		const refresh = (): void => {
			const view = currentView();
			banner.setText(view.banner.text);
			banner.toggleClass('linked-attachments-local-banner-unset', view.banner.warn);
			add.disabled = view.addDisabled;
			drawRows(view.activeIndex);
		};

		const drawRows = (activeIndex: number): void => {
			table.empty();
			const list = machines();
			if (list.length === 0) {
				table.createDiv({ cls: 'linked-attachments-local-empty', text: 'No machines configured yet.' });
			}
			list.forEach((entry, index) => {
				const isThis = index === activeIndex;
				const row = table.createDiv({ cls: 'linked-attachments-local-row' });
				row.toggleClass('linked-attachments-local-active', isThis);

				if (isThis) {
					row.createSpan({ cls: 'linked-attachments-local-thismarker', text: 'this machine' });
				}

				// The machine name is editable so a row can be renamed to a machine's new
				// hostname (after a rename or re-image) without losing its folder, and to
				// disambiguate a name collision. A rename can change which row is active,
				// so a committed edit re-renders through refresh().
				const nameInput = row.createEl('input', { type: 'text', cls: 'linked-attachments-local-name-input' });
				nameInput.value = entry.machine;
				nameInput.placeholder = 'Machine name';
				nameInput.addEventListener('change', () => {
					entry.machine = nameInput.value.trim();
					void this.plugin.saveSettings();
					refresh();
				});

				const pathInput = row.createEl('input', { type: 'text', cls: 'linked-attachments-local-input' });
				pathInput.value = entry.path;
				pathInput.placeholder = 'Absolute offload folder on this machine';
				pathInput.addEventListener('change', () => {
					entry.path = pathInput.value.trim();
					void this.plugin.saveSettings();
					refresh();
				});

				// Browse only on the machine you are physically at (the active one): a
				// picker here cannot reach another machine's filesystem.
				if (isThis) {
					const browse = row.createEl('button', { text: 'Browse', cls: 'linked-attachments-local-browse' });
					browse.addEventListener('click', () => {
						void (async (): Promise<void> => {
							// Seed with the resolved absolute path: a migrated/hand-entered
							// value may carry ~ or an env-var marker that Electron's
							// defaultPath cannot expand.
							const picked = await pickFolder(resolveLocalRoot(entry.path));
							if (picked === null) {
								return;
							}
							entry.path = picked;
							pathInput.value = picked;
							await this.plugin.saveSettings();
							refresh();
						})();
					});
				}

				const remove = row.createEl('button', { text: 'Remove', cls: 'linked-attachments-local-remove' });
				remove.setAttribute('aria-label', `Remove ${entry.machine.length > 0 ? entry.machine : 'this'} machine`);
				remove.addEventListener('click', () => {
					machines().splice(index, 1);
					void this.plugin.saveSettings();
					refresh();
				});
			});
		};

		add.addEventListener('click', () => {
			if (currentView().addDisabled) {
				return;
			}
			machines().push({ machine: thisMachine, path: '' });
			void this.plugin.saveSettings();
			refresh();
		});

		refresh();
	}

	// One backfill button per backend the current storage mode writes. A pointer
	// created under a past mode can lack a backend the mode now uses, so each active
	// backend gets a "copy the missing files in now" button. Recomputed whenever the
	// storage-mode dropdown changes (setControlValue calls update()), so the buttons
	// track the mode live without a settings reopen.
	private backfillItems(): SettingGroupItem[] {
		const mode = this.plugin.settings.storageMode;
		const targets: Array<'local' | 's3'> = [];
		if (mode === 'local-only' || mode === 'local-s3') {
			targets.push('local');
		}
		if (mode === 's3-only' || mode === 'local-s3') {
			targets.push('s3');
		}
		return targets.map((target) => ({
			name: target === 'local' ? 'Copy all files to the local mirror now' : 'Copy all files to the S3 mirror now',
			desc: `Give every existing pointer the ${target === 'local' ? 'local' : 'S3'} copy it is missing, read from its other backend and verified on write. Safe to re-run: a pointer that already has this copy is skipped.`,
			searchable: false,
			render: (setting: Setting) => { this.renderBackfillRow(setting, target); },
		}));
	}

	private renderBackfillRow(setting: Setting, target: 'local' | 's3'): void {
		const statusEl = setting.descEl.createDiv({ cls: 'linked-attachments-secret-status' });
		setting.addButton((btn) =>
			btn.setButtonText(target === 'local' ? 'Copy to local' : 'Copy to S3').onClick(async () => {
				const gate = this.backfillReady(target);
				if (!gate.ok) {
					this.applyStatus(statusEl, gate.reason, 'error');
					return;
				}
				btn.setDisabled(true);
				this.applyStatus(statusEl, 'Copying...', 'neutral');
				const result = await this.plugin.runAddMirror(target);
				btn.setDisabled(false);
				if (result === null) {
					this.applyStatus(statusEl, 'Backfill failed; see the notice for details.', 'error');
					return;
				}
				this.applyStatus(statusEl, `${result.added} added, ${result.skipped} skipped, ${result.failed} failed.`, result.failed > 0 ? 'error' : 'ok');
			}),
		);
	}

	// Same readiness gate the add-mirror commands use, so the button matches command
	// availability. Returns the hint to show inline when a backend is not configured.
	private backfillReady(target: 'local' | 's3'): { ok: true } | { ok: false; reason: string } {
		if (target === 'local') {
			return resolveLocalRoot(selectActiveRoot(this.plugin.settings)).length > 0
				? { ok: true }
				: { ok: false, reason: 'Set this machine\'s local folder above first.' };
		}
		const ready = this.plugin.settings.endpoint.length > 0 && this.plugin.settings.bucket.length > 0 && this.plugin.credentials.hasCompleteCredentials();
		return ready ? { ok: true } : { ok: false, reason: 'Set the endpoint, bucket, and credentials first.' };
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

// Open the OS folder picker (Electron, desktop-only). Returns the chosen absolute
// path, or null if the user cancels or the picker is unavailable (they can still
// type the path). @electron/remote is external and provided by Obsidian's runtime.
async function pickFolder(current: string): Promise<string | null> {
	try {
		const { dialog } = await import('@electron/remote');
		const start = current.trim();
		const result = await dialog.showOpenDialog({
			title: 'Choose the local offload folder',
			defaultPath: start.length > 0 && !start.includes('%') && !start.includes('$') ? start : undefined,
			properties: ['openDirectory', 'createDirectory'],
		});
		if (result.canceled || result.filePaths.length === 0) {
			return null;
		}
		return result.filePaths[0] ?? null;
	} catch {
		new Notice('Folder picker is unavailable here; type or paste the path instead.');
		return null;
	}
}
