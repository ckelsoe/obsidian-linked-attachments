import { rewriteEmbedsToPointer, rewriteEmbedsToAttachment } from './references';

// R14 embed rewriting across the vault. The per-note transform lives in the proven
// scanner (references.ts); this is the orchestration over many notes: apply the
// right direction to each, and return ONLY the notes that actually changed so the
// service writes back the minimum. Pure - the vault read/write is the service's job,
// which keeps this tier-0 testable and the safety ordering (rewrite before the raw
// file or the pointer disappears) explicit at the call site.

export type RewriteDirection = 'to-pointer' | 'to-attachment';

export interface NoteContent {
	path: string;
	content: string;
}

export interface NoteRewrite {
	path: string;
	content: string;
	embedsRewritten: number;
}

export interface EmbedRewriteResult {
	rewrites: NoteRewrite[];
	embedsRewritten: number;
}

export function rewriteEmbedsInNotes(
	notes: NoteContent[],
	attachmentName: string,
	direction: RewriteDirection,
): EmbedRewriteResult {
	const rewrites: NoteRewrite[] = [];
	let embedsRewritten = 0;
	for (const note of notes) {
		const result =
			direction === 'to-pointer'
				? rewriteEmbedsToPointer(note.content, attachmentName)
				: rewriteEmbedsToAttachment(note.content, attachmentName);
		if (result.rewritten > 0) {
			rewrites.push({ path: note.path, content: result.text, embedsRewritten: result.rewritten });
			embedsRewritten += result.rewritten;
		}
	}
	return { rewrites, embedsRewritten };
}
