import { OffloadRule } from './offload-rules';
import { SweepFile, planVaultSweep } from './vault-sweep';
import { CHECKOUT_DIR_PREFIX } from './auto-offload';

// Tier 0: the vault sweep planner is pure. Given the vault's files and the shared
// rule table, it decides which files the retroactive sweep would offload and groups
// them by type for the preview. It applies the SAME decideByRules policy as the
// forward trigger, plus the same structural guards (never markdown, never a
// checked-out working copy). The actual enumeration (app.vault.getFiles) and the
// batch execution are the Obsidian-coupled layer; this is the selection + grouping.

const MB = 1024 * 1024;

function file(path: string, extension: string, sizeMb: number): SweepFile {
	return { path, extension, size: sizeMb * MB };
}

const RULES: OffloadRule[] = [
	{ extension: 'epub', mode: 'always', thresholdMb: 0 },
	{ extension: 'pdf', mode: 'over-size', thresholdMb: 5 },
];

describe('vault sweep planner', () => {
	// AC1 :: selects exactly the files the rules qualify - every epub (always) and
	// only PDFs at/over their threshold.
	it('test_selects_only_qualifying_files', () => {
		const files = [
			file('a.epub', 'epub', 0.1), // always -> selected
			file('b.pdf', 'pdf', 10), // over 5 -> selected
			file('c.pdf', 'pdf', 1), // under 5 -> skipped
			file('d.txt', 'txt', 100), // no rule -> skipped
		];
		const plan = planVaultSweep(files, RULES);
		expect(plan.selected.map((f) => f.path).sort()).toEqual(['a.epub', 'b.pdf']);
		expect(plan.skipped).toBe(2);
	});

	// AC2 :: groups the selection by extension with per-type count and total bytes,
	// and reports the overall total - this is what the preview shows.
	it('test_groups_by_extension_with_totals', () => {
		const files = [
			file('a.epub', 'epub', 1),
			file('b.epub', 'epub', 2),
			file('c.pdf', 'pdf', 10),
		];
		const plan = planVaultSweep(files, RULES);
		const epub = plan.groups.find((g) => g.extension === 'epub');
		const pdf = plan.groups.find((g) => g.extension === 'pdf');
		expect(epub).toEqual({ extension: 'epub', count: 2, totalBytes: 3 * MB });
		expect(pdf).toEqual({ extension: 'pdf', count: 1, totalBytes: 10 * MB });
		expect(plan.totalBytes).toBe(13 * MB);
	});

	// AC3 :: groups are ordered by total bytes descending - the biggest space win is
	// surfaced first.
	it('test_groups_sorted_by_total_size_desc', () => {
		const files = [file('a.epub', 'epub', 1), file('b.pdf', 'pdf', 50)];
		const plan = planVaultSweep(files, RULES);
		expect(plan.groups.map((g) => g.extension)).toEqual(['pdf', 'epub']);
	});

	// AC4 :: markdown is never swept (pointer notes and ordinary notes alike), even
	// if a stray 'md' rule exists - the heavy-bytes invariant only concerns
	// attachments, and sweeping notes would be catastrophic.
	it('test_never_sweeps_markdown', () => {
		const rules: OffloadRule[] = [{ extension: 'md', mode: 'always', thresholdMb: 0 }];
		const plan = planVaultSweep([file('note.md', 'md', 1), file('big.pdf.md', 'md', 9)], rules);
		expect(plan.selected).toEqual([]);
	});

	// AC5 :: a checked-out working copy under the plugin dir is never swept (it
	// returns to the bucket only via check-in).
	it('test_never_sweeps_checkout_copy', () => {
		const files = [file(`${CHECKOUT_DIR_PREFIX}checkout/abc/big.pdf`, 'pdf', 100)];
		const plan = planVaultSweep(files, RULES);
		expect(plan.selected).toEqual([]);
		expect(plan.skipped).toBe(1);
	});

	// AC6 :: an empty rule table sweeps nothing.
	it('test_empty_rules_selects_nothing', () => {
		const plan = planVaultSweep([file('a.pdf', 'pdf', 100)], []);
		expect(plan.selected).toEqual([]);
		expect(plan.groups).toEqual([]);
		expect(plan.totalBytes).toBe(0);
	});
});
