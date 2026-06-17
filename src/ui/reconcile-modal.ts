import { App, Modal, Notice, Setting } from 'obsidian';
import { AttachmentService } from '../service/attachment-service';
import { ReconcileFinding, ReconcileOutcome } from '../reconcile/scanner';
import { summarizeFindings, outcomeCopy } from '../reconcile/reconcile-view';

// The reconciliation results view (spec section 6 / dev-plan section 8): the moat
// made into a button. It scans (read-only), groups the findings into the four
// outcomes with plain-language copy, and offers exactly one action - link the
// unlinked candidates. Broken and drift are flagged and shown, never auto-fixed.
const OUTCOME_ORDER: ReconcileOutcome[] = ['unlinked', 'drift', 'broken', 'healthy'];

export class ReconcileModal extends Modal {
	private findings: ReconcileFinding[] = [];
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
		this.setTitle('Reconcile with storage');
		contentEl.createEl('p', { text: 'Compare your pointer notes against what is actually in your bucket. This only reads; it never deletes or overwrites anything.' });
		new Setting(contentEl).addButton((button) => button.setButtonText('Scan').setCta().onClick(() => { void this.runScan(); }));
		this.resultsEl = contentEl.createDiv();
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
			this.findings = await this.service.reconcile();
			this.renderFindings();
		} catch (error) {
			this.onError(error);
			this.resultsEl.empty();
			this.resultsEl.createEl('p', { text: 'The scan failed. See the log for details.' });
		}
	}

	private renderFindings(): void {
		if (this.resultsEl === null) {
			return;
		}
		this.resultsEl.empty();
		const summary = summarizeFindings(this.findings);
		this.resultsEl.createEl('p', {
			text: `${summary.total} checked: ${summary.healthy} healthy, ${summary.unlinked} not linked, ${summary.drift} changed, ${summary.broken} missing.`,
		});

		for (const outcome of OUTCOME_ORDER) {
			const group = this.findings.filter((f) => f.outcome === outcome);
			if (group.length === 0) {
				continue;
			}
			const copy = outcomeCopy(outcome);
			const section = this.resultsEl.createDiv({ cls: 'linked-attachments-reconcile-group' });
			section.createEl('h3', { text: `${copy.title} (${group.length})` });
			section.createEl('p', { cls: 'linked-attachments-reconcile-felt', text: copy.felt });
			const list = section.createDiv({ cls: 'linked-attachments-adopt' });
			for (const finding of group) {
				const row = list.createDiv({ cls: 'linked-attachments-adopt-row' });
				row.createSpan({ cls: 'linked-attachments-adopt-name', text: finding.key });
			}
		}

		if (summary.unlinked > 0) {
			new Setting(this.resultsEl).addButton((button) =>
				button
					.setButtonText(`Link ${summary.unlinked} unlinked`)
					.setCta()
					.onClick(() => { void this.runLink(); }),
			);
		}
	}

	private async runLink(): Promise<void> {
		try {
			const result = await this.service.linkFindings(this.findings);
			new Notice(`Linked ${result.created} object(s)${result.failed > 0 ? `, ${result.failed} failed` : ''}.`);
			void this.runScan();
		} catch (error) {
			this.onError(error);
			new Notice('Linking failed. See the log for details.');
		}
	}
}
