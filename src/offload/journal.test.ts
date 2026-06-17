import { createJournal, setStage, serializeJournal, parseJournal, unfinishedItems, isComplete } from './journal';

// The offload-session journal (spec section 4 worst-day recovery; the MINIMAL slice
// of O3 - not resumable-multipart, not a background queue). A per-batch record of
// each file's stage, written before the batch and updated per file, so recovery is
// deterministic: read the journal, skip what is done, finish the rest - instead of a
// full-vault rescan. Like the manifest, it is a rebuildable cache: a corrupt journal
// is discardable, never trusted.

describe('offload journal', () => {
	it('createJournal :: every file starts queued', () => {
		const journal = createJournal('batch-1', ['a.pdf', 'b.pdf'], '2026-06-17T00:00:00.000Z');
		expect(journal.batchId).toBe('batch-1');
		expect(journal.items.map((i) => i.stage)).toEqual(['queued', 'queued']);
	});

	it('setStage :: updates one item, leaves the rest', () => {
		const journal = setStage(createJournal('b', ['a.pdf', 'b.pdf'], 'now'), 'a.pdf', 'committed');
		expect(journal.items.find((i) => i.path === 'a.pdf')?.stage).toBe('committed');
		expect(journal.items.find((i) => i.path === 'b.pdf')?.stage).toBe('queued');
	});

	it('serialize/parse :: a journal round-trips', () => {
		const journal = setStage(createJournal('b', ['a.pdf'], 'now'), 'a.pdf', 'uploaded');
		const parsed = parseJournal(serializeJournal(journal));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.journal).toEqual(journal);
		}
	});

	it('parse :: a corrupt journal is discardable, never trusted', () => {
		expect(parseJournal('{ not json').ok).toBe(false);
		expect(parseJournal('{"batchId":"b"}').ok).toBe(false); // missing items
		expect(parseJournal('{"batchId":"b","startedAt":"now","items":"bad"}').ok).toBe(false);
	});

	it('unfinishedItems :: everything not removed is unfinished', () => {
		let journal = createJournal('b', ['done.pdf', 'mid.pdf', 'fresh.pdf'], 'now');
		journal = setStage(journal, 'done.pdf', 'removed');
		journal = setStage(journal, 'mid.pdf', 'uploaded');
		expect(unfinishedItems(journal).map((i) => i.path)).toEqual(['mid.pdf', 'fresh.pdf']);
	});

	it('isComplete :: true only when every item is removed', () => {
		let journal = createJournal('b', ['a.pdf', 'b.pdf'], 'now');
		journal = setStage(journal, 'a.pdf', 'removed');
		expect(isComplete(journal)).toBe(false);
		journal = setStage(journal, 'b.pdf', 'removed');
		expect(isComplete(journal)).toBe(true);
	});
});
