import { App, Notice, TFile } from 'obsidian';
import { AutoOffloadConfig, decideAutoOffload } from '../offload/auto-offload';

// The Obsidian-coupled layer over the pure auto-offload policy (spec section 4b).
// It listens for vault creates (and modifies, to reset the idle window) and, when
// the pure decision qualifies a file, either prompts (default) or schedules an
// idle-debounce offload (opt-in, desktop only). It adds NO offload mechanics - the
// actual work goes through the same offload pipeline via offloadNow, so the 1.1
// content-dedup pre-check runs automatically.
//
// Discipline: every idle timer is owned here and cleared on dispose (no stray
// timers). The decision is re-checked when a timer fires (the file may have grown,
// shrunk, or been deleted in the meantime). Prompt-by-default means nothing is ever
// offloaded without the user clicking; idle-debounce is the explicit opt-in.

export interface AutoOffloadControllerDeps {
	app: App;
	isDesktop: boolean;
	getConfig: () => AutoOffloadConfig;
	isReady: () => boolean; // storage configured (endpoint + bucket + credentials)
	offloadNow: (file: TFile) => Promise<void>;
	onError: (error: unknown) => void;
}

export class AutoOffloadController {
	// path -> pending idle-debounce timer id. Cleared on modify-reset and on dispose.
	private readonly idleTimers = new Map<string, number>();

	constructor(private readonly deps: AutoOffloadControllerDeps) {}

	// A new vault file appeared. Decide; prompt or schedule. No-op when storage is
	// not configured (never nag about a file the user cannot offload yet).
	onCreate(file: TFile): void {
		if (!this.deps.isReady()) {
			return;
		}
		const decision = decideAutoOffload(this.candidate(file), this.deps.getConfig(), this.deps.isDesktop);
		if (!decision.qualifies) {
			return;
		}
		if (decision.mode === 'idle-debounce') {
			this.scheduleIdle(file);
		} else {
			this.prompt(file);
		}
	}

	// A file changed: if it has a pending idle-offload, push the timer out so we only
	// offload once it has been genuinely untouched (dodges the mid-edit race).
	onModify(file: TFile): void {
		if (this.idleTimers.has(file.path)) {
			this.scheduleIdle(file);
		}
	}

	// Clear every pending timer (called on plugin unload).
	dispose(): void {
		for (const id of this.idleTimers.values()) {
			window.clearTimeout(id);
		}
		this.idleTimers.clear();
	}

	// --- internals --------------------------------------------------------------

	private candidate(file: TFile): { path: string; extension: string; size: number } {
		return { path: file.path, extension: file.extension, size: file.stat.size };
	}

	private scheduleIdle(file: TFile): void {
		const existing = this.idleTimers.get(file.path);
		if (existing !== undefined) {
			window.clearTimeout(existing);
		}
		const minutes = Math.max(1, this.deps.getConfig().idleMinutes);
		const id = window.setTimeout(() => {
			this.idleTimers.delete(file.path);
			void this.fireIdle(file.path);
		}, minutes * 60 * 1000);
		this.idleTimers.set(file.path, id);
	}

	// The idle window elapsed: re-fetch the file and re-decide (it may have changed
	// or been removed), then offload through the normal pipeline.
	private async fireIdle(path: string): Promise<void> {
		if (!this.deps.isReady()) {
			return;
		}
		const file = this.deps.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			return;
		}
		const decision = decideAutoOffload(this.candidate(file), this.deps.getConfig(), this.deps.isDesktop);
		if (!decision.qualifies) {
			return;
		}
		try {
			await this.deps.offloadNow(file);
		} catch (error) {
			this.deps.onError(error);
		}
	}

	// Prompt-by-default: a sticky notice offering the offload. Clicking it runs the
	// offload; ignoring it does nothing (it cannot eat a file the user is editing).
	private prompt(file: TFile): void {
		const sizeMb = (file.stat.size / (1024 * 1024)).toFixed(1);
		const fragment = createFragment();
		fragment.createSpan({ text: `${file.name} (${sizeMb} MB) will not sync well. ` });
		const action = fragment.createEl('a', { text: 'Offload it to storage', href: '#' });
		const notice = new Notice(fragment, 0);
		action.addEventListener('click', (event) => {
			event.preventDefault();
			notice.hide();
			void this.runPromptedOffload(file);
		});
	}

	private async runPromptedOffload(file: TFile): Promise<void> {
		try {
			await this.deps.offloadNow(file);
		} catch (error) {
			this.deps.onError(error);
		}
	}
}
