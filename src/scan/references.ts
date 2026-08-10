// The R14 reference scanner (spec section 7.3). It works on raw markdown text and
// answers three questions for offload / restore / GC:
//
//   1. Which embeds reference a given attachment, in EITHER the explicit
//      ![[file.ext.md]] form or the basename ![[file.ext]] form? Obsidian
//      normalizes the explicit form to the basename on rename (AC-G4), so both
//      must be treated as references to the pointer.
//   2. How do we re-canonicalize a basename embed to the explicit .md form on
//      offload (so the pointer is unambiguous from a restored raw file), and
//      reverse it on restore?
//   3. Is there any reference shape we do NOT manage (a markdown-style link to the
//      raw attachment)? If so, GC must be blocked conservatively.
//
// Embeds inside fenced or inline code are inert in Obsidian (not transcluded), so
// they are masked out: never rewritten, never counted as a reference.

export interface ReferenceMatch {
	raw: string; // the full matched token, e.g. "![[file.pdf#p|alias]]"
	embed: boolean; // true for ![[..]] (transclusion), false for [[..]] (link)
	target: string; // the link target, e.g. "folder/file.pdf"
	subpath: string; // "#heading" / "#page=3" / "", kept verbatim
	alias: string | null; // text after "|", or null
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

const WIKI_LINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
// Link text excludes both brackets ([^\][], not [^\]]). Excluding the opening "["
// keeps the class from matching a delimiter, which is what makes the match
// re-anchor super-linearly on a run of "[". Group 1 is still the URL.
const MARKDOWN_LINK = /!?\[[^\][]*\]\(([^)]+)\)/g;
const INLINE_CODE = /`[^`\n]+`/g;

export function scanReferences(text: string): ReferenceMatch[] {
	const masked = codeRanges(text);
	const matches: ReferenceMatch[] = [];
	for (const match of text.matchAll(WIKI_LINK)) {
		const index = match.index;
		if (inRanges(index, masked)) {
			continue;
		}
		const parsed = parseInside(match[2] ?? '');
		matches.push({
			raw: match[0],
			embed: match[1] === '!',
			target: parsed.target,
			subpath: parsed.subpath,
			alias: parsed.alias,
			start: index,
			end: index + match[0].length,
		});
	}
	return matches;
}

// True when `target` (path-qualified or not) names the attachment in either the
// basename form (file.ext) or the explicit pointer form (file.ext.md).
export function referencesAttachment(
	target: string,
	attachmentName: string,
): boolean {
	const base = basenameOf(target);
	return base === attachmentName || base === `${attachmentName}.md`;
}

// Offload: rewrite every embed that references the attachment to the explicit
// ![[...file.ext.md]] form, preserving the original path qualification, subpath,
// and alias. Already-explicit embeds are left as-is.
export function rewriteEmbedsToPointer(
	text: string,
	attachmentName: string,
): RewriteResult {
	return rewriteMatchingEmbeds(text, attachmentName, (target) => {
		if (basenameOf(target) === attachmentName) {
			return `${target}.md`;
		}
		return target; // already explicit
	});
}

// Restore: rewrite every explicit ![[...file.ext.md]] embed back to the raw
// attachment ![[...file.ext]].
export function rewriteEmbedsToAttachment(
	text: string,
	attachmentName: string,
): RewriteResult {
	return rewriteMatchingEmbeds(text, attachmentName, (target) => {
		if (basenameOf(target) === `${attachmentName}.md`) {
			return target.slice(0, target.length - '.md'.length);
		}
		return target; // already the basename form
	});
}

// GC analysis: the managed wiki references to the attachment, plus a conservative
// block if any markdown-style link to the raw attachment exists (a shape the wiki
// rewriter does not manage, so deleting the object could break it).
export function analyzeForGc(text: string, attachmentName: string): GcAnalysis {
	const references = scanReferences(text).filter((r) =>
		referencesAttachment(r.target, attachmentName),
	);
	const masked = codeRanges(text);
	for (const match of text.matchAll(MARKDOWN_LINK)) {
		if (inRanges(match.index, masked)) {
			continue;
		}
		const base = basenameOf(stripUrl(match[1] ?? ''));
		if (base === attachmentName || base === `${attachmentName}.md`) {
			return {
				references,
				gcBlocked: true,
				reason: `unmanaged markdown-style reference to ${attachmentName}`,
			};
		}
	}
	return { references, gcBlocked: false, reason: null };
}

// --- internals --------------------------------------------------------------

function rewriteMatchingEmbeds(
	text: string,
	attachmentName: string,
	remap: (target: string) => string,
): RewriteResult {
	const targets = scanReferences(text).filter(
		(r) => r.embed && referencesAttachment(r.target, attachmentName),
	);
	let result = text;
	let rewritten = 0;
	// Replace from the end so earlier indices stay valid.
	for (let i = targets.length - 1; i >= 0; i--) {
		const ref = targets[i];
		if (ref === undefined) {
			continue;
		}
		const newTarget = remap(ref.target);
		if (newTarget === ref.target) {
			continue;
		}
		const replacement = buildEmbed(newTarget, ref.subpath, ref.alias);
		result =
			result.slice(0, ref.start) + replacement + result.slice(ref.end);
		rewritten++;
	}
	return { text: result, rewritten };
}

function buildEmbed(
	target: string,
	subpath: string,
	alias: string | null,
): string {
	const aliasPart = alias !== null ? `|${alias}` : '';
	return `![[${target}${subpath}${aliasPart}]]`;
}

interface ParsedInside {
	target: string;
	subpath: string;
	alias: string | null;
}

function parseInside(inside: string): ParsedInside {
	let alias: string | null = null;
	let rest = inside;
	const pipe = inside.indexOf('|');
	if (pipe >= 0) {
		alias = inside.slice(pipe + 1);
		rest = inside.slice(0, pipe);
	}
	let subpath = '';
	let target = rest;
	const hash = rest.indexOf('#');
	if (hash >= 0) {
		subpath = rest.slice(hash);
		target = rest.slice(0, hash);
	}
	return { target, subpath, alias };
}

function basenameOf(target: string): string {
	const slash = target.lastIndexOf('/');
	return slash >= 0 ? target.slice(slash + 1) : target;
}

function stripUrl(url: string): string {
	let clean = url.trim();
	for (const sep of ['#', '?']) {
		const at = clean.indexOf(sep);
		if (at >= 0) {
			clean = clean.slice(0, at);
		}
	}
	return clean;
}

type Range = [number, number];

// The fenced-code ranges, reproducing the old /```[^\n]*\n[\s\S]*?```/g exactly but
// with indexOf scans instead of a regex. A regex that lets content contain "`" while
// the closing fence is "```" is super-linear (the content and the terminator can
// both start on a backtick), so it is done as a linear scan: for each opening ```,
// take the rest of that line up to the first newline, then close at the first ```
// after it (lazy). An opening with no following newline, or no later ```, matches
// nothing, and no later opening could either (its search window is a subset).
function fencedRanges(text: string): Range[] {
	const ranges: Range[] = [];
	let pos = 0;
	while (pos < text.length) {
		const open = text.indexOf('```', pos);
		if (open < 0) {
			break;
		}
		const newline = text.indexOf('\n', open + 3);
		if (newline < 0) {
			break;
		}
		const close = text.indexOf('```', newline + 1);
		if (close < 0) {
			break;
		}
		ranges.push([open, close + 3]);
		pos = close + 3;
	}
	return ranges;
}

function codeRanges(text: string): Range[] {
	const ranges: Range[] = fencedRanges(text);
	for (const match of text.matchAll(INLINE_CODE)) {
		if (!inRanges(match.index, ranges)) {
			ranges.push([match.index, match.index + match[0].length]);
		}
	}
	return ranges;
}

function inRanges(position: number, ranges: Range[]): boolean {
	return ranges.some(([start, end]) => position >= start && position < end);
}
