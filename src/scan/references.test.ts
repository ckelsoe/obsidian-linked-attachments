import fc from 'fast-check';
import {
	scanReferences,
	referencesAttachment,
	rewriteEmbedsToPointer,
	rewriteEmbedsToAttachment,
	analyzeForGc,
} from './references';

// Tier 0: the scanner operates on raw markdown text (the representation-
// independent mechanics of dev-plan track D). No Obsidian vault, no network.

describe('reference scanner acceptance (la-p1-03)', () => {
	// AC1 :: the explicit pointer form ![[file.ext.md]] is recognized as a
	// reference to the attachment file.ext. (spec section 5 AC-G4)
	it('test_recognizes_explicit_pointer_form', () => {
		expect(referencesAttachment('Cranfield.pdf.md', 'Cranfield.pdf')).toBe(true);
	});

	// AC2 :: the basename form ![[file.ext]] (what Obsidian normalizes the explicit
	// form to on rename) is recognized as equivalent. (spec section 5 AC-G4)
	it('test_recognizes_basename_form', () => {
		expect(referencesAttachment('Cranfield.pdf', 'Cranfield.pdf')).toBe(true);
		expect(referencesAttachment('Other.pdf', 'Cranfield.pdf')).toBe(false);
	});

	// AC3 :: offload re-canonicalizes the basename embed to the explicit .md form
	// so the pointer is unambiguous from a restored raw file. (spec section 5/6)
	it('test_recanonicalize_basename_to_explicit', () => {
		const out = rewriteEmbedsToPointer('see ![[Cranfield.pdf]] here', 'Cranfield.pdf');
		expect(out.text).toBe('see ![[Cranfield.pdf.md]] here');
		expect(out.rewritten).toBe(1);
	});

	// AC4 :: restore reverses the explicit .md embed back to the raw attachment.
	it('test_restore_reverses_to_attachment', () => {
		const out = rewriteEmbedsToAttachment('see ![[Cranfield.pdf.md]] here', 'Cranfield.pdf');
		expect(out.text).toBe('see ![[Cranfield.pdf]] here');
		expect(out.rewritten).toBe(1);
	});

	// AC5 :: an embed's alias and subpath survive the rewrite.
	it('test_alias_and_subpath_preserved', () => {
		const out = rewriteEmbedsToPointer('![[Cranfield.pdf#page=3|Romans commentary]]', 'Cranfield.pdf');
		expect(out.text).toBe('![[Cranfield.pdf.md#page=3|Romans commentary]]');
	});

	// AC6 :: a plain wikilink [[..]] is distinguished from an embed ![[..]]; only
	// embeds are re-canonicalized (a link to the pointer note already resolves).
	it('test_embed_vs_link_distinguished', () => {
		const refs = scanReferences('embed ![[Cranfield.pdf]] and link [[Cranfield.pdf.md]]');
		const embed = refs.find((r) => r.embed);
		const link = refs.find((r) => !r.embed);
		expect(embed?.target).toBe('Cranfield.pdf');
		expect(link?.target).toBe('Cranfield.pdf.md');
		// rewriteEmbedsToPointer touches the embed, not the plain link.
		const out = rewriteEmbedsToPointer('![[Cranfield.pdf]] [[Cranfield.pdf]]', 'Cranfield.pdf');
		expect(out.text).toBe('![[Cranfield.pdf.md]] [[Cranfield.pdf]]');
		expect(out.rewritten).toBe(1);
	});

	// AC7 :: a markdown-style reference to the raw attachment is a shape the wiki
	// rewriter does not manage; it must block GC conservatively. (spec section 7.3)
	it('test_unrecognized_shape_blocks_gc', () => {
		const md = analyzeForGc('![diagram](attachments/Cranfield.pdf)', 'Cranfield.pdf');
		expect(md.gcBlocked).toBe(true);
		// A vault with only a managed wiki embed does not block GC by this rule.
		const wiki = analyzeForGc('![[Cranfield.pdf.md]]', 'Cranfield.pdf');
		expect(wiki.gcBlocked).toBe(false);
	});

	// AC8 :: a path-qualified target matches by basename and keeps its path on
	// rewrite (the pointer sits beside the attachment).
	it('test_path_qualified_target_matches_by_basename', () => {
		expect(referencesAttachment('31-books/Romans/Cranfield.pdf', 'Cranfield.pdf')).toBe(true);
		const out = rewriteEmbedsToPointer('![[31-books/Romans/Cranfield.pdf]]', 'Cranfield.pdf');
		expect(out.text).toBe('![[31-books/Romans/Cranfield.pdf.md]]');
	});
});

describe('reference scanner property tests (la-p1-03)', () => {
	// prop_rewrite_then_restore_is_identity :: from a basename embed in arbitrary
	// surrounding text, rewrite-to-pointer then restore returns the original.
	it('prop_rewrite_then_restore_is_identity', () => {
		fc.assert(
			fc.property(
				fc.string({ unit: 'grapheme' }).filter((s) => !s.includes('[') && !s.includes(']') && !s.includes('`')),
				fc.string({ unit: 'grapheme' }).filter((s) => !s.includes('[') && !s.includes(']') && !s.includes('`')),
				(before, after) => {
					const original = `${before}![[Cranfield.pdf]]${after}`;
					const toPointer = rewriteEmbedsToPointer(original, 'Cranfield.pdf');
					const back = rewriteEmbedsToAttachment(toPointer.text, 'Cranfield.pdf');
					expect(back.text).toBe(original);
				},
			),
			{ numRuns: 200 },
		);
	});

	// prop_non_matching_embeds_untouched :: an embed to a DIFFERENT attachment is
	// never rewritten.
	it('prop_non_matching_embeds_untouched', () => {
		fc.assert(
			fc.property(fc.stringMatching(/^[a-z]{1,8}$/), (otherStem) => {
				fc.pre(otherStem !== 'cranfield');
				const text = `![[${otherStem}.pdf]]`;
				const out = rewriteEmbedsToPointer(text, 'Cranfield.pdf');
				expect(out.text).toBe(text);
				expect(out.rewritten).toBe(0);
			}),
			{ numRuns: 100 },
		);
	});
});

describe('reference scanner failure injection (la-p1-03)', () => {
	// An embed inside a fenced code block is not a live transclusion in Obsidian;
	// it must not be rewritten and must not count as a reference (else dead code
	// text would block GC forever).
	it('fault_embed_in_code_fence_ignored', () => {
		const text = '```\n![[Cranfield.pdf]]\n```\nreal ![[Cranfield.pdf]]';
		const out = rewriteEmbedsToPointer(text, 'Cranfield.pdf');
		expect(out.rewritten).toBe(1);
		expect(out.text).toBe('```\n![[Cranfield.pdf]]\n```\nreal ![[Cranfield.pdf.md]]');
		const gc = analyzeForGc('```\n![[Cranfield.pdf]]\n```', 'Cranfield.pdf');
		expect(gc.references).toHaveLength(0);
	});

	// An embed inside inline code is likewise inert.
	it('fault_embed_in_inline_code_ignored', () => {
		const out = rewriteEmbedsToPointer('`![[Cranfield.pdf]]` but real ![[Cranfield.pdf]]', 'Cranfield.pdf');
		expect(out.rewritten).toBe(1);
		expect(out.text).toBe('`![[Cranfield.pdf]]` but real ![[Cranfield.pdf.md]]');
	});

	// Malformed / unterminated brackets do not crash and do not falsely match.
	it('fault_malformed_brackets_no_crash', () => {
		expect(() => scanReferences('![[unterminated and [[ stray ]] text')).not.toThrow();
		const out = rewriteEmbedsToPointer('![[unterminated', 'Cranfield.pdf');
		expect(out.rewritten).toBe(0);
	});
});
