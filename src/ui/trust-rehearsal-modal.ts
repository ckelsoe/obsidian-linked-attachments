import { App, Modal, setIcon } from 'obsidian';
import { AttachmentService } from '../service/attachment-service';
import { TrustRehearsalResult, TrustStage, TrustStageId } from '../onboard/trust-ladder';
import { Logger } from '../../logger';

// S6 first-file round-trip trust check, rendered live (development-plan section 8
// "REHEARSE" beat). Opening the modal runs the rehearsal against the user's real
// bucket and shows each stage resolve in turn: uploaded, verified byte-for-byte,
// retrieved, matches the original. The verdict tells the user, before they trust a
// real file, whether their bucket round-trips correctly. Nothing in their vault is
// touched; the rehearsal uses a throwaway object and cleans it up.
export class TrustRehearsalModal extends Modal {
	private readonly rowStatus = new Map<TrustStageId, HTMLElement>();
	private verdictEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly service: AttachmentService,
		private readonly logger: Logger,
		private readonly onError: (error: unknown) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle('Rehearse a round-trip');
		contentEl.createEl('p', {
			text: 'Testing your bucket with a throwaway file. Nothing in your vault is touched.',
		});

		const stages: Array<{ id: TrustStageId; label: string }> = [
			{ id: 'uploaded', label: 'Uploaded' },
			{ id: 'verified', label: 'Verified byte-for-byte' },
			{ id: 'retrieved', label: 'Retrieved' },
			{ id: 'matched', label: 'Matches the original' },
		];
		const list = contentEl.createDiv({ cls: 'linked-attachments-ladder' });
		for (const stage of stages) {
			const row = list.createDiv({ cls: 'linked-attachments-ladder-row' });
			row.createSpan({ cls: 'linked-attachments-ladder-label', text: stage.label });
			const status = row.createSpan({ cls: 'linked-attachments-ladder-status' });
			status.setText('Waiting');
			this.rowStatus.set(stage.id, status);
		}
		this.verdictEl = contentEl.createDiv({ cls: 'linked-attachments-ladder-verdict' });

		void this.run();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async run(): Promise<void> {
		this.logger.info('Trust rehearsal started.');
		try {
			const result = await this.service.rehearseTrust((stage) => this.applyStage(stage));
			// Log the outcome including each stage's detail. A failed rehearsal is a
			// returned result (not a thrown error), so without this an honest stage
			// failure left no trace in the log.
			this.logger.info('Trust rehearsal finished.', {
				ok: result.ok,
				failedStage: result.failedStage,
				stages: result.stages.map((s) => ({ id: s.id, status: s.status, detail: s.detail })),
			});
			this.showVerdict(result);
		} catch (error) {
			this.onError(error);
			if (this.verdictEl !== null) {
				this.verdictEl.setText('The rehearsal could not run. See the log for details.');
				this.verdictEl.toggleClass('linked-attachments-ladder-verdict-error', true);
			}
		}
	}

	private applyStage(stage: TrustStage): void {
		const el = this.rowStatus.get(stage.id);
		if (el === undefined) {
			return;
		}
		el.empty();
		if (stage.status === 'passed') {
			setIcon(el.createSpan(), 'check');
			el.createSpan({ text: stage.detail ?? 'Passed' });
		} else if (stage.status === 'failed') {
			setIcon(el.createSpan(), 'x');
			el.createSpan({ text: stage.detail ?? 'Failed' });
		} else {
			el.setText('Running');
		}
		el.toggleClass('linked-attachments-ladder-status-passed', stage.status === 'passed');
		el.toggleClass('linked-attachments-ladder-status-failed', stage.status === 'failed');
	}

	private showVerdict(result: TrustRehearsalResult): void {
		if (this.verdictEl === null) {
			return;
		}
		if (result.ok) {
			this.verdictEl.setText('All four checks passed. Your bucket round-trips correctly, so an offload here is safe.');
		} else {
			const stage = result.stages.find((s) => s.id === result.failedStage);
			const reason = stage?.detail ?? result.error ?? 'unknown reason';
			this.verdictEl.setText(`Stopped at "${stage?.label ?? 'a check'}": ${reason}. Fix this before offloading a real file.`);
		}
		this.verdictEl.toggleClass('linked-attachments-ladder-verdict-ok', result.ok);
		this.verdictEl.toggleClass('linked-attachments-ladder-verdict-error', !result.ok);
	}
}
