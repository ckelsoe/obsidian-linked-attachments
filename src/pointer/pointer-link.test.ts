import { parsePointerLink } from './pointer-link';

describe('parsePointerLink', () => {
	// The current block format carries the verb on `op`; `action` stays the route so
	// it never collides with Obsidian's reserved protocol field.
	it('parses a current op-format link', () => {
		const params = parsePointerLink('obsidian://linked-attachments?op=reveal&backend=local&id=la-abc');
		expect(params.action).toBe('linked-attachments');
		expect(params.op).toBe('reveal');
		expect(params.backend).toBe('local');
		expect(params.id).toBe('la-abc');
	});

	// Links minted by earlier builds put the verb on `action`. The handler falls back
	// to `action` when `op` is absent, and those links must still resolve to a verb
	// (here the query `action` overrides the route default).
	it('parses a legacy action-format link', () => {
		const params = parsePointerLink('obsidian://linked-attachments?action=open&id=la-legacy');
		expect(params.action).toBe('open');
		expect(params.op).toBeUndefined();
		expect(params.id).toBe('la-legacy');
	});

	// A percent-encoded id round-trips (the block encodes the id so an odd id cannot
	// break the link).
	it('decodes a percent-encoded id', () => {
		const params = parsePointerLink('obsidian://linked-attachments?op=open&id=la%2Fweird%20id');
		expect(params.id).toBe('la/weird id');
	});

	// A malformed href never throws; it yields the bare route so the handler no-ops on
	// the missing id rather than crashing the click.
	it('returns the bare action for a malformed href', () => {
		const params = parsePointerLink('not a url');
		expect(params.action).toBe('linked-attachments');
		expect(params.id).toBeUndefined();
	});
});
