import { App, Modal, Setting } from 'obsidian';

// A small yes/no confirmation modal (Obsidian has no built-in confirm, and the
// browser confirm() is banned by lint). Resolves true on the call-to-action, false
// on cancel or dismiss. The CTA is rendered with setCta; callers phrase the body.

export interface ConfirmModalOptions {
	title: string;
	body: string;
	cta: string;
	onResult: (confirmed: boolean) => void;
}

export class ConfirmModal extends Modal {
	private decided = false;

	constructor(app: App, private readonly opts: ConfirmModalOptions) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.opts.title);
		this.contentEl.createEl('p', { text: this.opts.body });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(this.opts.cta)
					.setCta()
					.onClick(() => {
						this.decided = true;
						this.close();
						this.opts.onResult(true);
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.decided) {
			this.opts.onResult(false);
		}
	}
}
