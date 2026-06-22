import fc from 'fast-check';
import {
	decideAutoOffload,
	AutoOffloadConfig,
	AutoOffloadCandidate,
	CHECKOUT_DIR_PREFIX,
} from './auto-offload';
import { OffloadRule } from './offload-rules';

// Tier 0: the auto-offload trigger policy is pure (a candidate + config + platform
// in, a decision out). No vault, no events, no timers. This is the gate that decides
// whether a vault-create qualifies (spec section 4b); the event wiring + debounce
// timers + prompt are the Obsidian-coupled layer (la-p5-29, parked runtime). The
// type + size decision is delegated to the shared per-extension rule table
// (decideByRules), exercised directly in offload-rules.test.ts; here we cover the
// trigger-specific guards (enabled, checkout, markdown) and mode coercion.

const MB = 1024 * 1024;

const RULES: OffloadRule[] = [
	{ extension: 'pdf', mode: 'over-size', thresholdMb: 5 },
	{ extension: 'epub', mode: 'over-size', thresholdMb: 5 },
	{ extension: 'mp3', mode: 'over-size', thresholdMb: 5 },
	{ extension: 'zip', mode: 'over-size', thresholdMb: 5 },
];

function config(overrides: Partial<AutoOffloadConfig> = {}): AutoOffloadConfig {
	return {
		enabled: true,
		rules: RULES,
		triggerMode: 'prompt',
		idleMinutes: 5,
		...overrides,
	};
}

function candidate(overrides: Partial<AutoOffloadCandidate> = {}): AutoOffloadCandidate {
	return { path: 'inbox/big.pdf', extension: 'pdf', size: 10 * MB, ...overrides };
}

describe('auto-offload trigger policy (la-p5-28)', () => {
	// AC1 :: an allowlisted type over the size threshold qualifies, prompt mode.
	it('test_qualifies_type_and_size', () => {
		const d = decideAutoOffload(candidate(), config(), true);
		expect(d.qualifies).toBe(true);
		if (d.qualifies) {
			expect(d.mode).toBe('prompt');
		}
	});

	// AC2 :: a small file is left alone (small files sync fine - spec section 4b).
	it('test_rejects_small_file', () => {
		const d = decideAutoOffload(candidate({ size: 1 * MB }), config(), true);
		expect(d.qualifies).toBe(false);
		if (!d.qualifies) {
			expect(d.reason).toMatch(/size|threshold|small/i);
		}
	});

	// AC3 :: a type with no rule is not auto-offloaded (actively-authored types are
	// simply left out of the rule table).
	it('test_rejects_unlisted_type', () => {
		const d = decideAutoOffload(candidate({ path: 'note.txt', extension: 'txt' }), config(), true);
		expect(d.qualifies).toBe(false);
		if (!d.qualifies) {
			expect(d.reason).toMatch(/rule|listed/i);
		}
	});

	// AC4 :: disabled never qualifies (off by default; the whole feature is opt-in).
	it('test_disabled_never_qualifies', () => {
		const d = decideAutoOffload(candidate(), config({ enabled: false }), true);
		expect(d.qualifies).toBe(false);
	});

	// AC5 :: a checked-out working copy is never auto-offloaded (spec section 4b);
	// it returns to the bucket only via the explicit check-in.
	it('test_skips_checkout_working_copy', () => {
		const d = decideAutoOffload(
			candidate({ path: `${CHECKOUT_DIR_PREFIX}checkout/abc123/big.pdf` }),
			config(),
			true,
		);
		expect(d.qualifies).toBe(false);
		if (!d.qualifies) {
			expect(d.reason).toMatch(/checked|working copy|linked-attachments/i);
		}
	});

	// AC6 :: a markdown note (including a pointer note) is never auto-offloaded.
	it('test_skips_markdown', () => {
		const d = decideAutoOffload(candidate({ path: 'big.pdf.md', extension: 'md' }), config(), true);
		expect(d.qualifies).toBe(false);
	});

	// AC7 :: the over-size threshold flows through from the matched rule; exactly at
	// the threshold qualifies, one byte under is left alone.
	it('test_size_threshold_boundary', () => {
		const cfg = config({ rules: [{ extension: 'pdf', mode: 'over-size', thresholdMb: 1 }] });
		expect(decideAutoOffload(candidate({ size: 1 * MB }), cfg, true).qualifies).toBe(true);
		expect(decideAutoOffload(candidate({ size: 1 * MB - 1 }), cfg, true).qualifies).toBe(false);
	});

	// AC7b :: an 'always' rule qualifies a tiny file (the new capability the old
	// allowlist + global threshold could not express).
	it('test_always_rule_qualifies_small_file', () => {
		const cfg = config({ rules: [{ extension: 'epub', mode: 'always', thresholdMb: 0 }] });
		const d = decideAutoOffload(candidate({ extension: 'epub', path: 'x.epub', size: 1 }), cfg, true);
		expect(d.qualifies).toBe(true);
	});

	// AC8 :: idle-debounce is coerced to prompt on mobile (mobile may prompt but
	// never idle-sweeps - spec section 4b / section 6); it stays idle on desktop.
	it('test_idle_coerced_to_prompt_on_mobile', () => {
		const cfg = config({ triggerMode: 'idle-debounce' });
		const onDesktop = decideAutoOffload(candidate(), cfg, true);
		const onMobile = decideAutoOffload(candidate(), cfg, false);
		expect(onDesktop.qualifies && onDesktop.mode).toBe('idle-debounce');
		expect(onMobile.qualifies && onMobile.mode).toBe('prompt');
	});

	// AC9 :: case-insensitive type match (an uppercase extension still qualifies).
	it('test_type_match_case_insensitive', () => {
		const d = decideAutoOffload(candidate({ extension: 'PDF' }), config(), true);
		expect(d.qualifies).toBe(true);
	});
});

describe('auto-offload property (la-p5-28)', () => {
	// prop :: a file under its type's over-size threshold never qualifies, for every
	// type/threshold pair (size is the primary signal for over-size rules).
	it('prop_never_qualifies_below_threshold', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 2, max: 1000 }),
				fc.constantFrom('pdf', 'epub', 'mp3', 'zip'),
				(thresholdMb, ext) => {
					const cfg = config({ rules: [{ extension: ext, mode: 'over-size', thresholdMb }] });
					// One byte under the threshold: must never qualify.
					const d = decideAutoOffload(
						candidate({ extension: ext, path: `x.${ext}`, size: thresholdMb * MB - 1 }),
						cfg,
						true,
					);
					expect(d.qualifies).toBe(false);
				},
			),
			{ numRuns: 100 },
		);
	});
});
