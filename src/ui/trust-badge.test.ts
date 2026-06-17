import { trustBadge } from './trust-badge';
import { VerificationTier } from '../pointer/codec';
import { defaultCanRemoveOriginal } from '../offload/pipeline';

// Trust badges (development-plan section 8 trust-copy table). The UI verb segregates
// by what was actually confirmed: Verified (bytes proven) / Found (exists, bytes not
// re-checked) / Asserted (catalogued, never checked). The honesty discipline is the
// feature, so the badge must never claim more than the tier earned - and its
// "unlocks one-click delete" must equal the real delete gate, not a separate guess.

describe('trustBadge', () => {
	it('content -> Verified, unlocks delete', () => {
		const badge = trustBadge('content');
		expect(badge.kind).toBe('verified');
		expect(badge.label).toBe('Verified');
		expect(badge.cardLine).toBe('Confirmed byte-for-byte');
		expect(badge.unlocksDelete).toBe(true);
	});

	it('md5 -> Verified (a byte-integrity match also unlocks delete)', () => {
		const badge = trustBadge('md5');
		expect(badge.kind).toBe('verified');
		expect(badge.unlocksDelete).toBe(true);
	});

	it('existence -> Found, does not unlock delete', () => {
		const badge = trustBadge('existence');
		expect(badge.kind).toBe('found');
		expect(badge.label).toBe('Found');
		expect(badge.cardLine).toBe('We see it exists');
		expect(badge.unlocksDelete).toBe(false);
	});

	it('asserted -> Asserted, does not unlock delete', () => {
		const badge = trustBadge('asserted');
		expect(badge.kind).toBe('asserted');
		expect(badge.label).toBe('Asserted');
		expect(badge.cardLine).toBe('You told us it\'s there');
		expect(badge.unlocksDelete).toBe(false);
	});

	it('every tier has a non-empty tooltip', () => {
		for (const tier of ['content', 'md5', 'existence', 'asserted'] as VerificationTier[]) {
			expect(trustBadge(tier).tooltip.length).toBeGreaterThan(0);
		}
	});

	// The cross-check that keeps the badge honest: "unlocks one-click delete" is the
	// real gate, not a parallel opinion that can drift from it.
	it('unlocksDelete matches the pipeline delete gate for every tier', () => {
		for (const tier of ['content', 'md5', 'existence', 'asserted'] as VerificationTier[]) {
			expect(trustBadge(tier).unlocksDelete).toBe(defaultCanRemoveOriginal(tier));
		}
	});
});
