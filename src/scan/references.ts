// STUB (la-p1-03 RED). Implementation lands in the GREEN commit.

export interface ReferenceMatch {
	raw: string;
	embed: boolean;
	target: string;
	subpath: string;
	alias: string | null;
	start: number;
	end: number;
}

export interface RewriteResult {
	text: string;
	rewritten: number;
}

export interface GcAnalysis {
	references: ReferenceMatch[];
	gcBlocked: boolean;
	reason: string | null;
}

export function scanReferences(_text: string): ReferenceMatch[] {
	throw new Error('not implemented');
}

export function referencesAttachment(_target: string, _attachmentName: string): boolean {
	throw new Error('not implemented');
}

export function rewriteEmbedsToPointer(_text: string, _attachmentName: string): RewriteResult {
	throw new Error('not implemented');
}

export function rewriteEmbedsToAttachment(_text: string, _attachmentName: string): RewriteResult {
	throw new Error('not implemented');
}

export function analyzeForGc(_text: string, _attachmentName: string): GcAnalysis {
	throw new Error('not implemented');
}
