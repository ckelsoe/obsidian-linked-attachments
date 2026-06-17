import { OffloadStage } from './pipeline';

// The offload-session journal (spec section 4): a per-batch record of each file's
// stage, written before the batch and updated per file, so recovery is a
// deterministic "skip what is done, finish the rest" instead of a full-vault
// rescan. It is a rebuildable cache, strictly scoped to the active batch: a corrupt
// journal is discarded, never trusted (the manifest-is-output discipline).

export type JournalStage = 'queued' | OffloadStage | 'failed';

export interface JournalItem {
	path: string;
	stage: JournalStage;
}

export interface OffloadJournal {
	batchId: string;
	startedAt: string;
	items: JournalItem[];
}

export type JournalParseResult = { ok: true; journal: OffloadJournal } | { ok: false; reason: string };

export function createJournal(batchId: string, paths: string[], startedAt: string): OffloadJournal {
	return { batchId, startedAt, items: paths.map((path) => ({ path, stage: 'queued' })) };
}

// Immutable stage update: a new journal with one item advanced.
export function setStage(journal: OffloadJournal, path: string, stage: JournalStage): OffloadJournal {
	return {
		...journal,
		items: journal.items.map((item) => (item.path === path ? { path, stage } : item)),
	};
}

export function serializeJournal(journal: OffloadJournal): string {
	return JSON.stringify(journal);
}

export function parseJournal(text: string): JournalParseResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, reason: 'not valid JSON' };
	}
	if (typeof raw !== 'object' || raw === null) {
		return { ok: false, reason: 'not an object' };
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.batchId !== 'string' || typeof obj.startedAt !== 'string' || !Array.isArray(obj.items)) {
		return { ok: false, reason: 'missing or wrong-typed fields' };
	}
	const items: JournalItem[] = [];
	for (const entry of obj.items) {
		if (typeof entry !== 'object' || entry === null) {
			return { ok: false, reason: 'malformed item' };
		}
		const item = entry as Record<string, unknown>;
		if (typeof item.path !== 'string' || typeof item.stage !== 'string') {
			return { ok: false, reason: 'malformed item' };
		}
		items.push({ path: item.path, stage: item.stage as JournalStage });
	}
	return { ok: true, journal: { batchId: obj.batchId, startedAt: obj.startedAt, items } };
}

// What recovery must still do: everything not confirmed removed. A removed item is
// done; any other stage (queued / uploaded / verified / committed / failed) is
// re-run, and the pipeline's re-verify-on-resume makes that safe.
export function unfinishedItems(journal: OffloadJournal): JournalItem[] {
	return journal.items.filter((item) => item.stage !== 'removed');
}

export function isComplete(journal: OffloadJournal): boolean {
	return journal.items.every((item) => item.stage === 'removed');
}
