import { App, Modal, Setting, TFile, setIcon } from 'obsidian';
import { AttachmentService } from '../service/attachment-service';
import { formatBytes, OffloadPlan } from '../offload/plan';
import { BatchItem } from '../offload/batch';
import { OffloadResult } from '../offload/pipeline';

// Batch offload with the B7 dry-run table and the H5 progress modal in one flow:
//   1. Preview - a table of every selected file, its size, and where it will go,
//      plus the total. Nothing has moved.
//   2. Progress - on confirm, each file runs in turn with a live status row.
//   3. Summary - how many offloaded, how many kept, how many failed.
// The plan and the runner are pure and tested; this is the live shell around them.
export class BatchOffloadModal extends Modal {
	private readonly rowStatus = new Map<string, HTMLElement>();

	constructor(
		app: App,
		private readonly service: AttachmentService,
		private readonly files: TFile[],
		private readonly onError: (error: unknown) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Offload several files');
		void this.showPreview();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async showPreview(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', { text: `${this.files.length} file(s) selected. Nothing has been moved yet. Review, then confirm.` });

		let plans: OffloadPlan[];
		try {
			plans = await this.service.planOffloadMany(this.files);
		} catch (error) {
			this.onError(error);
			contentEl.createEl('p', { text: 'Could not prepare the preview. See the log for details.' });
			return;
		}

		const table = contentEl.createDiv({ cls: 'linked-attachments-filelist' });
		let total = 0;
		for (const plan of plans) {
			total += plan.byteSize;
			this.row(table, plan.originalName, formatBytes(plan.byteSize), false);
		}
		this.row(table, `Total (${plans.length})`, formatBytes(total), true);

		new Setting(contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText('Offload all')
					.setCta()
					.onClick(() => { void this.runBatch(); }),
			);
	}

	private async runBatch(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', { text: 'Offloading. Each file is uploaded, verified, then the local original goes to trash.' });

		const list = contentEl.createDiv({ cls: 'linked-attachments-ladder' });
		this.rowStatus.clear();
		for (const file of this.files) {
			const row = list.createDiv({ cls: 'linked-attachments-ladder-row' });
			row.createSpan({ cls: 'linked-attachments-ladder-label', text: file.name });
			const status = row.createSpan({ cls: 'linked-attachments-ladder-status', text: 'Queued' });
			this.rowStatus.set(file.path, status);
		}
		const summary = contentEl.createDiv({ cls: 'linked-attachments-ladder-verdict' });

		try {
			const progress = await this.service.offloadMany(this.files, (item) => this.applyItem(item));
			const done = progress.items.filter((i) => i.status === 'done' && i.result?.removed).length;
			const kept = progress.items.filter((i) => i.status === 'done' && !i.result?.removed).length;
			const failed = progress.items.filter((i) => i.status === 'failed').length;
			summary.setText(`Done. ${done} offloaded, ${kept} kept (not at the delete-gate tier), ${failed} failed.`);
			summary.toggleClass('linked-attachments-ladder-verdict-ok', failed === 0);
			summary.toggleClass('linked-attachments-ladder-verdict-error', failed > 0);
		} catch (error) {
			this.onError(error);
			summary.setText('The batch could not run. See the log for details.');
			summary.toggleClass('linked-attachments-ladder-verdict-error', true);
		}
	}

	private applyItem(item: BatchItem<OffloadResult>): void {
		const el = this.rowStatus.get(item.id);
		if (el === undefined) {
			return;
		}
		el.empty();
		if (item.status === 'running') {
			el.setText('Offloading');
		} else if (item.status === 'done') {
			setIcon(el.createSpan(), 'check');
			el.createSpan({ text: item.result?.removed ? 'Offloaded' : 'Kept' });
		} else if (item.status === 'failed') {
			setIcon(el.createSpan(), 'x');
			el.createSpan({ text: item.error ?? 'Failed' });
		}
		el.toggleClass('linked-attachments-ladder-status-passed', item.status === 'done');
		el.toggleClass('linked-attachments-ladder-status-failed', item.status === 'failed');
	}

	private row(parent: HTMLElement, label: string, value: string, emphasize: boolean): void {
		const row = parent.createDiv({ cls: 'linked-attachments-filelist-row' });
		row.toggleClass('linked-attachments-filelist-total', emphasize);
		row.createSpan({ cls: 'linked-attachments-filelist-name', text: label });
		row.createSpan({ cls: 'linked-attachments-filelist-size', text: value });
	}
}
