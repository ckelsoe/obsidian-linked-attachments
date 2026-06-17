import { App, Modal, Setting } from 'obsidian';
import { OffloadPlan, formatBytes } from '../offload/plan';

// B7 dry-run preview (development-plan section 8). Shows the user exactly where a
// file will go BEFORE anything moves: the destination bucket and key, the pointer
// note path, and the size. The plan it renders is computed by the same module the
// offload pipeline uses, so the preview never disagrees with the commit. Confirming
// runs the real offload; cancelling moves nothing.
export class OffloadPreviewModal extends Modal {
	constructor(
		app: App,
		private readonly plan: OffloadPlan,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle('Offload preview');
		contentEl.createEl('p', {
			text: 'Nothing has been moved yet. Review where this file will go, then confirm.',
		});

		const table = contentEl.createDiv({ cls: 'linked-attachments-plan' });
		this.row(table, 'File', this.plan.originalName);
		this.row(table, 'Size', formatBytes(this.plan.byteSize));
		this.row(table, 'Bucket', this.plan.bucket);
		this.row(table, 'Destination key', this.plan.key);
		this.row(table, 'Pointer note', this.plan.pointerPath);

		new Setting(contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText('Offload')
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private row(parent: HTMLElement, label: string, value: string): void {
		const row = parent.createDiv({ cls: 'linked-attachments-plan-row' });
		row.createSpan({ cls: 'linked-attachments-plan-label', text: label });
		row.createSpan({ cls: 'linked-attachments-plan-value', text: value });
	}
}
