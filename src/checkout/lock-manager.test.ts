import { evaluateLock, conflictCopyName } from './lock-manager';

// Tier 0: the advisory cross-device lock is evaluated from the pointer's checkout
// markers (which ride the user's sync). There is no server - the lock is advisory:
// warn, default to read-only, allow a force escape for a stale lock (spec section
// 4a). Pure: markers + this host + a clock in, a verdict out.

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-06-18T12:00:00.000Z');

describe('advisory lock evaluation (la-p6-30)', () => {
	// AC1 :: no checkout markers -> free.
	it('test_free_when_no_checkout', () => {
		const v = evaluateLock({ checkout: null, thisHost: 'mbp', nowMs: NOW, staleAfterMs: 24 * HOUR });
		expect(v.state).toBe('free');
	});

	// AC2 :: checked out by THIS host -> held-by-me (editable here).
	it('test_held_by_me', () => {
		const v = evaluateLock({
			checkout: { host: 'mbp', at: '2026-06-18T11:00:00.000Z' },
			thisHost: 'mbp',
			nowMs: NOW,
			staleAfterMs: 24 * HOUR,
		});
		expect(v.state).toBe('held-by-me');
	});

	// AC3 :: checked out by ANOTHER host within the stale window -> held-by-other
	// (warn + read-only default). The message names the host and time.
	it('test_held_by_other_warns_with_host_and_time', () => {
		const v = evaluateLock({
			checkout: { host: 'work-pc', at: '2026-06-18T11:00:00.000Z' },
			thisHost: 'mbp',
			nowMs: NOW,
			staleAfterMs: 24 * HOUR,
		});
		expect(v.state).toBe('held-by-other');
		expect(v.message).toContain('work-pc');
	});

	// AC4 :: checked out by another host but older than the stale window -> stale
	// (offer a force escape).
	it('test_stale_lock_offers_force', () => {
		const v = evaluateLock({
			checkout: { host: 'work-pc', at: '2026-06-15T11:00:00.000Z' },
			thisHost: 'mbp',
			nowMs: NOW,
			staleAfterMs: 24 * HOUR,
		});
		expect(v.state).toBe('stale');
		expect(v.message).toMatch(/stale|force/i);
	});

	// AC5 :: an unparseable timestamp from another host is treated as held-by-other
	// (never silently free; we cannot prove it is stale).
	it('test_unparseable_time_is_held_by_other', () => {
		const v = evaluateLock({
			checkout: { host: 'work-pc', at: 'not-a-date' },
			thisHost: 'mbp',
			nowMs: NOW,
			staleAfterMs: 24 * HOUR,
		});
		expect(v.state).toBe('held-by-other');
	});
});

describe('conflict copy naming (la-p6-30)', () => {
	// AC6 :: a conflicting check-in preserves the loser as a recognizable .conflict
	// copy (LWW + detect-and-preserve-both, never a merge engine - section 4a).
	it('test_conflict_copy_name_keeps_extension', () => {
		const name = conflictCopyName('budget.xlsx', 'work-pc', '2026-06-18T11:00:00.000Z');
		expect(name).toContain('budget');
		expect(name).toContain('conflict');
		expect(name).toContain('work-pc');
		expect(name.endsWith('.xlsx')).toBe(true);
	});

	it('test_conflict_copy_name_no_extension', () => {
		const name = conflictCopyName('README', 'h', '2026-06-18T11:00:00.000Z');
		expect(name).toContain('README');
		expect(name).toContain('conflict');
	});
});
