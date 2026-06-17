import { App, Modal, Notice, Setting } from 'obsidian';
import { AttachmentService } from '../service/attachment-service';
import { AdoptRow } from '../adopt/adopt-scan';
import { summarizeRows } from '../adopt/adopt-plan';
import { formatBytes } from '../offload/plan';

// Adopt-from-bucket UI (spec section 4 Link bullet). The scope wall is honored: the
// only actions are LIST-under-a-prefix and CREATE pointers. The user recognizes
// files by NAME and ticks a flat checklist; they never handle a raw key. A
// secondary paste-a-key field serves the power user who already has the exact key.
export class AdoptModal extends Modal {
	private prefix = '';
	private destinationFolder = '';
	private pasteKey = '';
	private rows: AdoptRow[] = [];
	private readonly selected = new Set<string>();
	private resultsEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly service: AttachmentService,
		private readonly onError: (error: unknown) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle('Adopt files from storage');
		contentEl.createEl('p', { text: 'List objects already in your bucket and create pointer notes for them. Adopted files are catalogued, not yet byte-verified.' });

		new Setting(contentEl)
			.setName('Prefix')
			.setDesc('Only list objects whose key starts with this. Leave empty to list from the top.')
			.addText((text) => text.setPlaceholder('Prefix to list under').onChange((value) => { this.prefix = value; }));
		new Setting(contentEl)
			.setName('Destination folder')
			.setDesc('Optional vault folder to place the pointer notes under.')
			.addButton((button) => button.setButtonText('Scan').setCta().onClick(() => { void this.runScan(); }))
			.addText((text) => text.setPlaceholder('Vault folder for the pointers').onChange((value) => { this.destinationFolder = value; }));

		this.resultsEl = contentEl.createDiv();

		contentEl.createEl('hr');
		new Setting(contentEl)
			.setName('Paste a key')
			.setDesc('Already have an exact object key from your S3 browser? Adopt it directly.')
			.addText((text) => text.setPlaceholder('books/Romans/Cranfield--9f86d0.pdf').onChange((value) => { this.pasteKey = value; }))
			.addButton((button) => button.setButtonText('Adopt key').onClick(() => { void this.runPasteKey(); }));
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async runScan(): Promise<void> {
		if (this.resultsEl === null) {
			return;
		}
		this.resultsEl.empty();
		this.resultsEl.createEl('p', { text: 'Scanning...' });
		try {
			const result = await this.service.adoptScan(this.prefix, this.destinationFolder);
			this.rows = result.rows;
			this.selected.clear();
			this.renderRows();
		} catch (error) {
			this.onError(error);
			this.resultsEl.empty();
			this.resultsEl.createEl('p', { text: 'The scan failed. See the log for details.' });
		}
	}

	private renderRows(): void {
		if (this.resultsEl === null) {
			return;
		}
		this.resultsEl.empty();
		const summary = summarizeRows(this.rows);
		this.resultsEl.createEl('p', {
			text: `${summary.adoptable} adoptable, ${summary.alreadyAdopted} already adopted, ${summary.collision} would collide.`,
		});

		const list = this.resultsEl.createDiv({ cls: 'linked-attachments-adopt' });
		for (const row of this.rows) {
			const rowEl = list.createDiv({ cls: 'linked-attachments-adopt-row' });
			if (row.status === 'adoptable') {
				const checkbox = rowEl.createEl('input', { type: 'checkbox' });
				checkbox.addEventListener('change', () => {
					if (checkbox.checked) {
						this.selected.add(row.key);
					} else {
						this.selected.delete(row.key);
					}
				});
				rowEl.createSpan({ cls: 'linked-attachments-adopt-name', text: row.displayName });
				rowEl.createSpan({ cls: 'linked-attachments-adopt-size', text: formatBytes(row.size) });
			} else {
				rowEl.createSpan({ cls: 'linked-attachments-adopt-name', text: row.displayName });
				rowEl.createSpan({
					cls: 'linked-attachments-adopt-size',
					text: row.status === 'already-adopted' ? 'Already adopted' : 'Name in use',
				});
				rowEl.toggleClass('linked-attachments-adopt-row-disabled', true);
			}
		}

		if (summary.adoptable > 0) {
			new Setting(this.resultsEl).addButton((button) =>
				button
					.setButtonText('Adopt selected')
					.setCta()
					.onClick(() => { void this.runAdopt(); }),
			);
		}
	}

	private async runAdopt(): Promise<void> {
		const chosen = this.rows.filter((row) => this.selected.has(row.key));
		if (chosen.length === 0) {
			new Notice('Tick at least one file to adopt.');
			return;
		}
		try {
			const result = await this.service.adoptRows(chosen);
			new Notice(`Adopted ${result.created} file(s)${result.failed > 0 ? `, ${result.failed} failed` : ''}.`);
			void this.runScan();
		} catch (error) {
			this.onError(error);
			new Notice('Adoption failed. See the log for details.');
		}
	}

	private async runPasteKey(): Promise<void> {
		if (this.pasteKey.length === 0) {
			new Notice('Paste an object key first.');
			return;
		}
		try {
			const result = await this.service.adoptKey(this.pasteKey);
			new Notice(result.ok ? `Adopted ${result.pointerPath}.` : `Could not adopt: ${result.error ?? 'unknown error'}.`);
		} catch (error) {
			this.onError(error);
			new Notice('Adoption failed. See the log for details.');
		}
	}
}
