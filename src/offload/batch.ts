// A generic sequential batch runner (development-plan section 2 0.2: batch offload
// + the H5 progress modal). Items run one at a time - predictable and never a bucket
// storm - emitting per-item progress for the modal. The defining property: one
// item's failure NEVER aborts the batch; the failure is recorded and the rest run.
// Pure and injected (the real offload is passed in), so the sequencing, progress,
// and failure isolation are proven tier-0.

export type BatchItemStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface BatchItem<T> {
	id: string;
	status: BatchItemStatus;
	result: T | null;
	error: string | null;
}

export interface BatchProgress<T> {
	items: BatchItem<T>[];
	completed: number;
	total: number;
}

export interface BatchRunOutcome<T> {
	ok: boolean;
	value?: T;
	error?: string | null;
}

export interface RunBatchDeps<I, T> {
	items: I[];
	idOf: (item: I) => string;
	run: (item: I, index: number) => Promise<BatchRunOutcome<T>>;
	onProgress?: (item: BatchItem<T>, progress: BatchProgress<T>) => void;
}

export async function runBatch<I, T>(deps: RunBatchDeps<I, T>): Promise<BatchProgress<T>> {
	const items: BatchItem<T>[] = deps.items.map((item) => ({ id: deps.idOf(item), status: 'queued', result: null, error: null }));
	const progress: BatchProgress<T> = { items, total: items.length, completed: 0 };
	const emit = (item: BatchItem<T>): void => deps.onProgress?.(item, progress);

	for (let i = 0; i < deps.items.length; i++) {
		const source = deps.items[i];
		const item = items[i];
		if (source === undefined || item === undefined) {
			continue;
		}
		item.status = 'running';
		emit(item);
		try {
			const outcome = await deps.run(source, i);
			if (outcome.ok) {
				item.status = 'done';
				item.result = outcome.value ?? null;
			} else {
				item.status = 'failed';
				item.error = outcome.error ?? 'failed';
			}
		} catch (error) {
			// A thrown run is contained as a failure; the batch continues so one bad
			// file never strands the rest.
			item.status = 'failed';
			item.error = error instanceof Error ? error.message : String(error);
		}
		progress.completed++;
		emit(item);
	}
	return progress;
}
