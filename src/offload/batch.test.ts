import fc from 'fast-check';
import { runBatch, BatchItem } from './batch';

// Batch offload runner (development-plan section 2 0.2: batch offload + H5 progress).
// Runs items one at a time (predictable, never a bucket storm), emits per-item
// progress for the H5 modal, and - critically - one file's failure never aborts the
// batch: the rest still run and the failure is recorded. Pure and tier-0: the real
// offload is injected, so the sequencing, progress, and failure-isolation are proven
// without a vault or a bucket.

describe('runBatch', () => {
	it('AC1 test_runs_all_sequentially :: every item reaches done', async () => {
		const progress = await runBatch<string, string>({
			items: ['a', 'b', 'c'],
			idOf: (x) => x,
			run: (x) => Promise.resolve({ ok: true, value: x.toUpperCase() }),
		});
		expect(progress.completed).toBe(3);
		expect(progress.total).toBe(3);
		expect(progress.items.every((i) => i.status === 'done')).toBe(true);
		expect(progress.items.map((i) => i.result)).toEqual(['A', 'B', 'C']);
	});

	it('AC2 test_failure_does_not_abort_batch :: a failed item is isolated', async () => {
		const progress = await runBatch<string, string>({
			items: ['a', 'bad', 'c'],
			idOf: (x) => x,
			run: (x) => (x === 'bad' ? Promise.resolve({ ok: false, error: 'nope' }) : Promise.resolve({ ok: true, value: x })),
		});
		expect(progress.items.map((i) => i.status)).toEqual(['done', 'failed', 'done']);
		expect(progress.items[1]?.error).toBe('nope');
		expect(progress.completed).toBe(3);
	});

	it('AC3 test_progress_emitted_per_item :: running then a terminal status for each', async () => {
		const events: string[] = [];
		await runBatch<string, string>({
			items: ['a', 'b'],
			idOf: (x) => x,
			run: (x) => Promise.resolve({ ok: true, value: x }),
			onProgress: (item) => events.push(`${item.id}:${item.status}`),
		});
		expect(events).toEqual(['a:running', 'a:done', 'b:running', 'b:done']);
	});

	it('AC4 test_order_preserved :: items run in input order', async () => {
		const seen: string[] = [];
		await runBatch<string, string>({
			items: ['first', 'second', 'third'],
			idOf: (x) => x,
			run: (x) => { seen.push(x); return Promise.resolve({ ok: true, value: x }); },
		});
		expect(seen).toEqual(['first', 'second', 'third']);
	});

	it('AC5 test_empty_batch :: no items is a clean no-op', async () => {
		const progress = await runBatch<string, string>({ items: [], idOf: (x) => x, run: () => Promise.resolve({ ok: true }) });
		expect(progress.total).toBe(0);
		expect(progress.completed).toBe(0);
		expect(progress.items).toEqual([]);
	});

	it('fault_run_throws_is_failed :: a thrown run is contained, batch continues', async () => {
		const progress = await runBatch<string, string>({
			items: ['a', 'boom', 'c'],
			idOf: (x) => x,
			run: (x) => { if (x === 'boom') { throw new Error('kaboom'); } return Promise.resolve({ ok: true, value: x }); },
		});
		expect(progress.items.map((i) => i.status)).toEqual(['done', 'failed', 'done']);
		expect(progress.items[1]?.error).toContain('kaboom');
	});

	it('prop_every_item_terminal :: no item is left queued or running', async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 8 }), async (oks) => {
				const items = oks.map((_, i) => `item-${i}`);
				const progress = await runBatch<string, number>({
					items,
					idOf: (x) => x,
					run: (_x, i) => (oks[i] ? Promise.resolve({ ok: true, value: i }) : Promise.resolve({ ok: false, error: 'x' })),
				});
				const terminal = (s: BatchItem<number>['status']): boolean => s === 'done' || s === 'failed' || s === 'skipped';
				expect(progress.items.every((it) => terminal(it.status))).toBe(true);
				expect(progress.completed).toBe(items.length);
			}),
			{ numRuns: 30 },
		);
	});
});
