import fc from 'fast-check';
import {
	TextExtractor,
	isTextBearing,
	extractText,
	renderTextSidecar,
	NO_TEXT_LAYER_MARKER,
} from './extract';

// Tier 0: pure policy over an injected extractor. No real PDF/EPUB parsing, no
// backend, no network. The real extractor is a Phase 3 concern; tests inject a
// fake so the no-text-layer / unsupported / failure decisions are exercised here.

function fixedExtractor(output: string): TextExtractor {
	return { extract: () => Promise.resolve(output) };
}

function throwingExtractor(message: string): TextExtractor {
	return {
		extract: () => Promise.reject(new Error(message)),
	};
}

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

describe('K1 text-extract acceptance (la-p1-06)', () => {
	// AC1 :: text-bearing formats are recognized; binary/media formats are not.
	// (spec section 1: optional per-format, only for text-bearing files)
	it('test_text_bearing_classification', () => {
		for (const ext of ['pdf', 'epub', 'docx', 'txt', 'PDF']) {
			expect(isTextBearing(ext)).toBe(true);
		}
		for (const ext of ['jpg', 'mp4', 'dwg', 'png', 'zip', '']) {
			expect(isTextBearing(ext)).toBe(false);
		}
	});

	// AC2 :: a text-bearing file with a real text layer extracts to state
	// "extracted" with the text returned.
	it('test_extracts_text', async () => {
		const result = await extractText('pdf', bytes('ignored'), fixedExtractor('Romans 1:17 the righteous shall live by faith'));
		expect(result.state).toBe('extracted');
		expect(result.text).toBe('Romans 1:17 the righteous shall live by faith');
	});

	// AC3 :: a text-bearing file whose extractor yields only whitespace is marked
	// no-text-layer explicitly, never "extracted" with empty text (spec section 9:
	// search must never silently lie).
	it('test_no_text_layer_marked', async () => {
		const result = await extractText('pdf', bytes('scanned'), fixedExtractor('   \n\t  '));
		expect(result.state).toBe('no-text-layer');
		expect(result.text).toBeNull();
		expect(result.reason).not.toBeNull();
	});

	// AC4 :: a non-text-bearing format is "unsupported"; the extractor is never
	// invoked.
	it('test_unsupported_format_no_extraction', async () => {
		let calls = 0;
		const spy: TextExtractor = {
			extract: () => {
				calls++;
				return Promise.resolve('should not run');
			},
		};
		const result = await extractText('mp4', bytes('video'), spy);
		expect(result.state).toBe('unsupported');
		expect(result.text).toBeNull();
		expect(calls).toBe(0);
	});

	// AC5 :: an extractor failure is captured as "failed" with a reason, never an
	// unhandled crash (so a bad file cannot abort an offload batch).
	it('test_extractor_failure_explicit', async () => {
		const result = await extractText('pdf', bytes('corrupt'), throwingExtractor('stream decode error'));
		expect(result.state).toBe('failed');
		expect(result.text).toBeNull();
		expect(result.reason).toContain('stream decode error');
	});

	// AC6 :: the rendered sidecar for a no-text-layer file carries an explicit
	// marker so a search hit (or miss) is never silently misleading.
	it('test_sidecar_marks_no_text_layer', async () => {
		const result = await extractText('pdf', bytes('scanned'), fixedExtractor(''));
		const sidecar = renderTextSidecar(result, 'Cranfield.pdf');
		expect(sidecar).not.toBeNull();
		expect(sidecar).toContain(NO_TEXT_LAYER_MARKER);
	});

	// AC7 :: a text-bearing file that yields only a few stray characters (below the
	// meaningful threshold) is treated as no-text-layer (scanned detection).
	it('test_scanned_below_threshold', async () => {
		const result = await extractText('pdf', bytes('scan'), fixedExtractor('3'), { minMeaningfulChars: 16 });
		expect(result.state).toBe('no-text-layer');
	});

	// The extracted sidecar contains the text so the vault search can index it.
	it('test_extracted_sidecar_contains_text', async () => {
		const result = await extractText('epub', bytes('book'), fixedExtractor('chapter one had a long body of searchable text'));
		const sidecar = renderTextSidecar(result, 'book.epub');
		expect(sidecar).toContain('chapter one had a long body of searchable text');
	});
});

describe('K1 text-extract property tests (la-p1-06)', () => {
	// prop_never_silently_empty :: for ANY extractor output, the result is never
	// "extracted" with empty/whitespace-only text. The honesty invariant.
	it('prop_never_silently_empty', async () => {
		await fc.assert(
			fc.asyncProperty(fc.string(), async (output) => {
				const result = await extractText('pdf', bytes('x'), fixedExtractor(output), { minMeaningfulChars: 1 });
				if (result.state === 'extracted') {
					expect(result.text).not.toBeNull();
					expect((result.text ?? '').trim().length).toBeGreaterThan(0);
				}
			}),
			{ numRuns: 200 },
		);
	});

	// prop_extracted_text_preserved :: text with enough meaningful characters is
	// returned verbatim.
	it('prop_extracted_text_preserved', async () => {
		await fc.assert(
			fc.asyncProperty(fc.string({ minLength: 40 }).filter((s) => s.trim().length >= 16), async (text) => {
				const result = await extractText('pdf', bytes('x'), fixedExtractor(text), { minMeaningfulChars: 16 });
				expect(result.state).toBe('extracted');
				expect(result.text).toBe(text);
			}),
			{ numRuns: 200 },
		);
	});
});

describe('K1 text-extract failure injection (la-p1-06)', () => {
	// A rejected extractor promise is contained, not propagated.
	it('fault_extractor_rejection_contained', async () => {
		await expect(extractText('pdf', bytes('x'), throwingExtractor('boom'))).resolves.toMatchObject({ state: 'failed' });
	});

	// A non-Error throw is still captured with a reason.
	it('fault_non_error_throw_captured', async () => {
		// A non-Error thrown value (typed unknown so it genuinely hits the
		// String(error) branch of the catch, not the error.message branch).
		const nonError: unknown = 'plain string failure';
		const weird: TextExtractor = {
			extract: () => {
				throw nonError;
			},
		};
		const result = await extractText('pdf', bytes('x'), weird);
		expect(result.state).toBe('failed');
		expect(result.reason).toContain('plain string failure');
	});

	// Unsupported and failed states produce no sidecar (null), so no empty file is
	// written that would imply searchable content.
	it('fault_no_sidecar_for_unsupported_or_failed', async () => {
		const unsupported = await extractText('png', bytes('img'), fixedExtractor('x'));
		expect(renderTextSidecar(unsupported, 'a.png')).toBeNull();
		const failed = await extractText('pdf', bytes('x'), throwingExtractor('nope'));
		expect(renderTextSidecar(failed, 'a.pdf')).toBeNull();
	});
});
