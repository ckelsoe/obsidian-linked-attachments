import fc from 'fast-check';
import {
	OffloadRule,
	RuleCandidate,
	decideByRules,
	normalizeExtension,
	normalizeRules,
	rulesFromLegacy,
} from './offload-rules';

// Tier 0: the per-extension offload rule policy is pure (a candidate + the rule
// table in, a decision out). It is the single source of truth consulted by BOTH
// the forward auto-offload trigger (on vault create) and the retroactive vault
// sweep, so the two can never diverge. Each rule is either "always" (offload this
// type regardless of size) or "over-size" (offload only at/over its own MB
// threshold). A type with no rule is never offloaded.

const MB = 1024 * 1024;

function rule(overrides: Partial<OffloadRule> = {}): OffloadRule {
	return { extension: 'pdf', mode: 'over-size', thresholdMb: 5, ...overrides };
}

function candidate(overrides: Partial<RuleCandidate> = {}): RuleCandidate {
	return { extension: 'pdf', size: 10 * MB, ...overrides };
}

describe('offload rule policy (per-extension)', () => {
	// AC1 :: an "always" rule offloads its type at any size, even a tiny file.
	it('test_always_rule_offloads_regardless_of_size', () => {
		const rules = [rule({ extension: 'epub', mode: 'always' })];
		const d = decideByRules(candidate({ extension: 'epub', size: 1 }), rules);
		expect(d.offload).toBe(true);
		if (d.offload) {
			expect(d.matched.extension).toBe('epub');
		}
	});

	// AC2 :: an "over-size" rule offloads only at or over its own threshold.
	it('test_over_size_rule_respects_its_threshold', () => {
		const rules = [rule({ extension: 'pdf', mode: 'over-size', thresholdMb: 10 })];
		expect(decideByRules(candidate({ extension: 'pdf', size: 10 * MB }), rules).offload).toBe(true);
		const under = decideByRules(candidate({ extension: 'pdf', size: 10 * MB - 1 }), rules);
		expect(under.offload).toBe(false);
		if (!under.offload) {
			expect(under.reason).toMatch(/size|threshold/i);
		}
	});

	// AC3 :: each over-size rule carries its OWN threshold (small PDFs but only big
	// videos). This is the whole point of per-extension thresholds.
	it('test_per_extension_thresholds_are_independent', () => {
		const rules = [
			rule({ extension: 'pdf', mode: 'over-size', thresholdMb: 1 }),
			rule({ extension: 'mp4', mode: 'over-size', thresholdMb: 100 }),
		];
		// A 5 MB file: a PDF is offloaded (over 1 MB), a video is left alone (under 100 MB).
		expect(decideByRules(candidate({ extension: 'pdf', size: 5 * MB }), rules).offload).toBe(true);
		expect(decideByRules(candidate({ extension: 'mp4', size: 5 * MB }), rules).offload).toBe(false);
	});

	// AC4 :: a type with no matching rule is never offloaded (absence == never).
	it('test_unlisted_type_never_offloads', () => {
		const rules = [rule({ extension: 'pdf' })];
		const d = decideByRules(candidate({ extension: 'txt', size: 999 * MB }), rules);
		expect(d.offload).toBe(false);
		if (!d.offload) {
			expect(d.reason).toMatch(/rule|listed|txt/i);
		}
	});

	// AC5 :: type match is case-insensitive (an uppercase extension still matches a
	// lowercase rule).
	it('test_match_case_insensitive', () => {
		const rules = [rule({ extension: 'epub', mode: 'always' })];
		expect(decideByRules(candidate({ extension: 'EPUB', size: 1 }), rules).offload).toBe(true);
	});

	// AC6 :: the over-size threshold is inclusive (>=); exactly at the threshold
	// offloads, matching the existing auto-offload boundary semantics.
	it('test_threshold_boundary_inclusive', () => {
		const rules = [rule({ extension: 'pdf', mode: 'over-size', thresholdMb: 1 })];
		expect(decideByRules(candidate({ extension: 'pdf', size: 1 * MB }), rules).offload).toBe(true);
		expect(decideByRules(candidate({ extension: 'pdf', size: 1 * MB - 1 }), rules).offload).toBe(false);
	});

	// AC7 :: an empty rule table offloads nothing.
	it('test_empty_table_offloads_nothing', () => {
		expect(decideByRules(candidate(), []).offload).toBe(false);
	});

	// AC7c :: a disabled rule offloads nothing even when it would otherwise match
	// (the rule stays configured but paused). enabled === false is the off switch;
	// undefined or true is on.
	it('test_disabled_rule_offloads_nothing', () => {
		const off = decideByRules(candidate({ extension: 'epub', size: 999 * MB }), [
			rule({ extension: 'epub', mode: 'always', enabled: false }),
		]);
		expect(off.offload).toBe(false);
		if (!off.offload) {
			expect(off.reason).toMatch(/off|disabled|turned/i);
		}
		// The same rule enabled does offload.
		expect(decideByRules(candidate({ extension: 'epub', size: 1 }), [
			rule({ extension: 'epub', mode: 'always', enabled: true }),
		]).offload).toBe(true);
	});
});

describe('offload rule normalization', () => {
	// AC8 :: extension normalization lowercases, strips a leading dot, and trims.
	it('test_normalize_extension', () => {
		expect(normalizeExtension('  .PDF ')).toBe('pdf');
		expect(normalizeExtension('EPUB')).toBe('epub');
	});

	// AC9 :: normalizeRules drops blank extensions, normalizes the rest, clamps a
	// negative threshold to 0, and keeps the FIRST rule when a type is duplicated
	// (so a stray duplicate row can never silently shadow the intended rule).
	it('test_normalize_rules_dedupes_and_clamps', () => {
		const cleaned = normalizeRules([
			{ extension: '.PDF', mode: 'over-size', thresholdMb: 10 },
			{ extension: 'pdf', mode: 'always', thresholdMb: 0 },
			{ extension: '   ', mode: 'always', thresholdMb: 1 },
			{ extension: 'mp4', mode: 'over-size', thresholdMb: -5 },
		]);
		expect(cleaned).toEqual([
			{ extension: 'pdf', mode: 'over-size', thresholdMb: 10, enabled: true },
			{ extension: 'mp4', mode: 'over-size', thresholdMb: 0, enabled: true },
		]);
	});

	// AC9b :: normalizeRules persists enabled explicitly: a missing field becomes
	// true, an explicit false is preserved.
	it('test_normalize_rules_persists_enabled', () => {
		const cleaned = normalizeRules([
			{ extension: 'pdf', mode: 'over-size', thresholdMb: 5 },
			{ extension: 'epub', mode: 'always', thresholdMb: 0, enabled: false },
		]);
		expect(cleaned).toEqual([
			{ extension: 'pdf', mode: 'over-size', thresholdMb: 5, enabled: true },
			{ extension: 'epub', mode: 'always', thresholdMb: 0, enabled: false },
		]);
	});
});

describe('legacy settings migration', () => {
	// AC10 :: the old allowlist + single global threshold migrate to one over-size
	// rule per type, each carrying the old global threshold. Replacing the old model
	// must not silently change what already qualified.
	it('test_migrates_allowlist_to_over_size_rules', () => {
		expect(rulesFromLegacy('pdf, EPUB, .mp3', 5)).toEqual([
			{ extension: 'pdf', mode: 'over-size', thresholdMb: 5, enabled: true },
			{ extension: 'epub', mode: 'over-size', thresholdMb: 5, enabled: true },
			{ extension: 'mp3', mode: 'over-size', thresholdMb: 5, enabled: true },
		]);
	});

	it('test_migrates_empty_allowlist_to_no_rules', () => {
		expect(rulesFromLegacy('   ', 5)).toEqual([]);
	});
});

describe('offload rule property', () => {
	// prop :: with a single over-size rule, qualification is EXACTLY size >= threshold
	// for the matching type, for every size/threshold pair.
	it('prop_over_size_is_exactly_ge_threshold', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 10_000 }),
				fc.integer({ min: 0, max: 1_000 }),
				(sizeMb, thresholdMb) => {
					const rules = [rule({ extension: 'bin', mode: 'over-size', thresholdMb })];
					const d = decideByRules(candidate({ extension: 'bin', size: sizeMb * MB }), rules);
					expect(d.offload).toBe(sizeMb * MB >= thresholdMb * MB);
				},
			),
			{ numRuns: 100 },
		);
	});
});
