// K1 text extraction (spec section 1, section 7.6, section 9). An OPTIONAL
// per-format feature for text-bearing files (PDF / EPUB / DOCX / ...): keep the
// extracted text locally so vault search survives offload. The product
// requirement is honesty, not a parser - a scanned document with no text layer
// must be marked explicitly so search never silently lies (spec section 9).
//
// This module owns the policy: which formats are text-bearing, when an extraction
// is "real" vs a no-text-layer scan, how failures are contained, and what the
// sidecar says. The actual byte-level extractor (a PDF/EPUB reader) is injected
// (TextExtractor) - real implementations are a Phase 3 concern that needs a
// library and the Obsidian runtime.

export const NO_TEXT_LAYER_MARKER = 'no text layer';

// Below this many non-whitespace characters, a text-bearing file is treated as
// having no usable text layer (a scanned page often yields a few stray glyphs or
// a page number). Tunable per call.
const DEFAULT_MIN_MEANINGFUL_CHARS = 16;

const TEXT_BEARING_EXTENSIONS = new Set(['pdf', 'epub', 'docx', 'txt', 'md', 'rtf', 'html', 'htm']);

export type ExtractionState = 'extracted' | 'no-text-layer' | 'unsupported' | 'failed';

export interface ExtractionResult {
	state: ExtractionState;
	text: string | null;
	meaningfulChars: number;
	reason: string | null;
}

export interface TextExtractor {
	extract(bytes: Uint8Array): Promise<string>;
}

export interface ExtractOptions {
	minMeaningfulChars?: number;
}

export function isTextBearing(ext: string): boolean {
	return TEXT_BEARING_EXTENSIONS.has(ext.toLowerCase());
}

export async function extractText(
	ext: string,
	bytes: Uint8Array,
	extractor: TextExtractor,
	options: ExtractOptions = {},
): Promise<ExtractionResult> {
	if (!isTextBearing(ext)) {
		return {
			state: 'unsupported',
			text: null,
			meaningfulChars: 0,
			reason: `${ext.length > 0 ? ext : 'this format'} is not a text-bearing format`,
		};
	}

	let raw: string;
	try {
		raw = await extractor.extract(bytes);
	} catch (error) {
		// Contain the failure: a single corrupt file must not abort an offload
		// batch. The reason carries the detail (spec code-structure rule 7).
		return { state: 'failed', text: null, meaningfulChars: 0, reason: `extraction failed: ${describe(error)}` };
	}

	const meaningfulChars = countMeaningful(raw);
	const threshold = options.minMeaningfulChars ?? DEFAULT_MIN_MEANINGFUL_CHARS;
	if (meaningfulChars < threshold) {
		return {
			state: 'no-text-layer',
			text: null,
			meaningfulChars,
			reason: 'no extractable text layer (likely a scanned document); not searchable',
		};
	}

	return { state: 'extracted', text: raw, meaningfulChars, reason: null };
}

// The local text sidecar. For an extraction, the searchable text; for a
// no-text-layer file, an explicit honest marker so a search miss is never
// silently misleading. Unsupported / failed states write no sidecar (null) so no
// empty file ever implies searchable content.
export function renderTextSidecar(result: ExtractionResult, sourceName: string): string | null {
	switch (result.state) {
		case 'extracted':
			return result.text;
		case 'no-text-layer':
			return [
				`> [!warning] ${capitalize(NO_TEXT_LAYER_MARKER)}`,
				`> ${sourceName} has ${NO_TEXT_LAYER_MARKER} and is not searchable (likely a scanned document).`,
				'',
			].join('\n');
		case 'unsupported':
		case 'failed':
			return null;
	}
}

// --- internals --------------------------------------------------------------

function countMeaningful(text: string): number {
	let count = 0;
	for (const ch of text) {
		if (!/\s/.test(ch)) {
			count++;
		}
	}
	return count;
}

function capitalize(value: string): string {
	return value.length > 0 ? value[0]?.toUpperCase() + value.slice(1) : value;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
