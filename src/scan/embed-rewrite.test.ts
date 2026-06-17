import fc from 'fast-check';
import { rewriteEmbedsInNotes } from './embed-rewrite';

// R14 embed rewriting wired across the vault (spec section 3 / 5, AC-G4). On
// offload, every note that embeds the raw attachment is rewritten to transclude the
// pointer (![[file.ext]] -> ![[file.ext.md]]); on restore the reverse. The per-note
// transform is the proven scanner; this orchestrator applies it across many notes,
// returns ONLY the notes that changed (so the service writes back the minimum), and
// is fully reversible. It is pure - the vault read/write is the service's job.

const note = (path: string, content: string): { path: string; content: string } => ({ path, content });

describe('rewriteEmbedsInNotes', () => {
	it('AC1 test_rewrites_basename_to_pointer :: offload direction targets the pointer', () => {
		const notes = [
			note('a.md', 'see ![[report.pdf]] here'),
			note('b.md', 'no embed here'),
		];
		const result = rewriteEmbedsInNotes(notes, 'report.pdf', 'to-pointer');
		expect(result.embedsRewritten).toBe(1);
		expect(result.rewrites).toHaveLength(1);
		expect(result.rewrites[0]?.path).toBe('a.md');
		expect(result.rewrites[0]?.content).toBe('see ![[report.pdf.md]] here');
	});

	it('AC2 test_rewrites_pointer_to_attachment :: restore direction targets the raw file', () => {
		const notes = [note('a.md', 'see ![[report.pdf.md]] here')];
		const result = rewriteEmbedsInNotes(notes, 'report.pdf', 'to-attachment');
		expect(result.embedsRewritten).toBe(1);
		expect(result.rewrites[0]?.content).toBe('see ![[report.pdf]] here');
	});

	it('AC3 test_only_changed_notes_returned :: unaffected notes are not rewritten', () => {
		const notes = [
			note('a.md', '![[report.pdf]]'),
			note('b.md', '![[other.pdf]]'),
			note('c.md', 'plain text'),
		];
		const result = rewriteEmbedsInNotes(notes, 'report.pdf', 'to-pointer');
		expect(result.rewrites.map((r) => r.path)).toEqual(['a.md']);
	});

	it('AC4 test_preserves_subpath_and_alias :: page anchor and caption survive', () => {
		const notes = [note('a.md', '![[docs/report.pdf#page=3|Cover]]')];
		const result = rewriteEmbedsInNotes(notes, 'report.pdf', 'to-pointer');
		expect(result.rewrites[0]?.content).toBe('![[docs/report.pdf.md#page=3|Cover]]');
	});

	it('AC5 test_code_fenced_embed_untouched :: an embed in code is inert', () => {
		const notes = [note('a.md', '```\n![[report.pdf]]\n```')];
		const result = rewriteEmbedsInNotes(notes, 'report.pdf', 'to-pointer');
		expect(result.embedsRewritten).toBe(0);
		expect(result.rewrites).toHaveLength(0);
	});

	it('AC6 test_multiple_embeds_one_note :: every embed in a note is rewritten', () => {
		const notes = [note('a.md', '![[report.pdf]] and again ![[report.pdf]]')];
		const result = rewriteEmbedsInNotes(notes, 'report.pdf', 'to-pointer');
		expect(result.embedsRewritten).toBe(2);
		expect(result.rewrites[0]?.content).toBe('![[report.pdf.md]] and again ![[report.pdf.md]]');
	});

	it('fault_empty_notes_no_changes :: no notes is a no-op, not a crash', () => {
		const result = rewriteEmbedsInNotes([], 'report.pdf', 'to-pointer');
		expect(result.embedsRewritten).toBe(0);
		expect(result.rewrites).toEqual([]);
	});

	it('prop_rewrite_roundtrip_across_notes :: to-pointer then to-attachment restores the originals', () => {
		fc.assert(
			fc.property(fc.array(fc.string(), { maxLength: 4 }), (bodies) => {
				const notes = bodies.map((b, i) => note(`n${i}.md`, `${b} ![[asset.bin]] ${b}`));
				const forward = rewriteEmbedsInNotes(notes, 'asset.bin', 'to-pointer');
				// apply forward rewrites, then reverse, and compare to the originals
				const afterForward = notes.map((n) => forward.rewrites.find((r) => r.path === n.path)?.content ?? n.content);
				const reversed = rewriteEmbedsInNotes(
					afterForward.map((content, i) => note(`n${i}.md`, content)),
					'asset.bin',
					'to-attachment',
				);
				for (let i = 0; i < notes.length; i++) {
					const final = reversed.rewrites.find((r) => r.path === `n${i}.md`)?.content ?? afterForward[i];
					expect(final).toBe(notes[i]?.content);
				}
			}),
			{ numRuns: 40 },
		);
	});
});
