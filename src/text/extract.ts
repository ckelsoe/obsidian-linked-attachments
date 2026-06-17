// STUB (la-p1-06 RED). Implementation lands in the GREEN commit.

export const NO_TEXT_LAYER_MARKER = 'no text layer';

export type ExtractionState = 'extracted' | 'no-text-layer' | 'unsupported' | 'failed';

export interface ExtractionResult {
	state: ExtractionState;
	text: string | null;
	meaningfulChars: number;
	reason: string | null;
}

// The pluggable extractor. Real implementations (a PDF / EPUB / DOCX text layer
// reader) are a Phase 3 concern that needs a library and the Obsidian runtime;
// this module owns only the policy around it, so tests inject a fake.
export interface TextExtractor {
	extract(bytes: Uint8Array): Promise<string>;
}

export interface ExtractOptions {
	minMeaningfulChars?: number;
}

export function isTextBearing(_ext: string): boolean {
	throw new Error('not implemented');
}

export function extractText(
	_ext: string,
	_bytes: Uint8Array,
	_extractor: TextExtractor,
	_options?: ExtractOptions,
): Promise<ExtractionResult> {
	throw new Error('not implemented');
}

export function renderTextSidecar(_result: ExtractionResult, _sourceName: string): string | null {
	throw new Error('not implemented');
}
