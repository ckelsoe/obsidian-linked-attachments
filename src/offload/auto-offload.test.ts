import fc from 'fast-check';
import {
	decideAutoOffload,
	parseAllowlist,
	AutoOffloadConfig,
	AutoOffloadCandidate,
	CHECKOUT_DIR_PREFIX,
} from './auto-offload';

// Tier 0: the auto-offload trigger policy is pure (a candidate + config + platform
// in, a decision out). No vault, no events, no timers. This is the gate that decides
// whether a vault-create qualifies (spec section 4b); the event wiring + debounce
// timers + prompt are the Obsidian-coupled layer (la-p5-29, parked runtime).

const MB = 1024 * 1024;

function config(overrides: Partial<AutoOffloadConfig> = {}): AutoOffloadConfig {
	return {
		enabled: true,
		allowlist: ['pdf', 'epub', 'mp3', 'zip'],
		sizeThresholdBytes: 5 * MB,
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

	// AC3 :: a non-allowlisted type is not auto-offloaded (actively-authored types
	// are excluded; type is the secondary filter).
	it('test_rejects_non_allowlisted_type', () => {
		const d = decideAutoOffload(candidate({ path: 'note.txt', extension: 'txt' }), config(), true);
		expect(d.qualifies).toBe(false);
		if (!d.qualifies) {
			expect(d.reason).toMatch(/type|allowlist/i);
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

	// AC7 :: the threshold is inclusive (>=); one byte under is left alone.
	it('test_size_threshold_boundary', () => {
		const cfg = config({ sizeThresholdBytes: 100 });
		expect(decideAutoOffload(candidate({ size: 100 }), cfg, true).qualifies).toBe(true);
		expect(decideAutoOffload(candidate({ size: 99 }), cfg, true).qualifies).toBe(false);
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

describe('auto-offload allowlist parsing (la-p5-28)', () => {
	it('test_parse_allowlist', () => {
		expect(parseAllowlist('pdf, EPUB , .mp3,,zip')).toEqual(['pdf', 'epub', 'mp3', 'zip']);
	});
	it('test_parse_empty', () => {
		expect(parseAllowlist('   ')).toEqual([]);
	});
});

describe('auto-offload property (la-p5-28)', () => {
	// prop :: a sub-threshold file never qualifies, regardless of type (size is the
	// primary signal - spec section 4b).
	it('prop_never_qualifies_below_threshold', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1000 }),
				fc.integer({ min: 1001, max: 100000 }),
				fc.constantFrom('pdf', 'epub', 'mp3', 'zip'),
				(size, threshold, ext) => {
					const d = decideAutoOffload(
						candidate({ extension: ext, path: `x.${ext}`, size }),
						config({ sizeThresholdBytes: threshold }),
						true,
					);
					expect(d.qualifies).toBe(false);
				},
			),
			{ numRuns: 100 },
		);
	});
});
