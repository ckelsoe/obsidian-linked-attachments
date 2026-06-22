import { App, Modal, Notice, Setting } from 'obsidian';

// A read-only view of the recent activity log, with a one-click copy so the user
// can paste it into an issue report. The log is the append-only audit.jsonl (every
// bucket op plus app warnings/errors); this modal just renders the tail of it. It
// never writes, so opening it is always safe.
export class LogViewModal extends Modal {
	constructor(
		app: App,
		private readonly load: () => Promise<string>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Activity log');
		void this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', {
			text: 'The most recent activity, including every storage operation and any warnings or errors. Copy it to include in a bug report.',
		});

		let text: string;
		try {
			text = await this.load();
		} catch (error) {
			contentEl.createEl('p', { text: `Could not read the log: ${error instanceof Error ? error.message : String(error)}` });
			return;
		}

		const area = contentEl.createEl('textarea', { cls: 'linked-attachments-log-view' });
		area.readOnly = true;
		area.setText(text.length > 0 ? text : 'The log is empty.');

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText('Copy to clipboard')
					.setCta()
					.onClick(async () => {
						if (text.length === 0) {
							new Notice('The log is empty; nothing to copy.');
							return;
						}
						await navigator.clipboard.writeText(text);
						new Notice('Log copied to the clipboard.');
					}),
			)
			.addButton((button) => button.setButtonText('Close').onClick(() => this.close()));
	}
}
