import { removeEntry } from '../src/ui/remove-entry';

describe('removeEntry', () => {
	it('removes the entry itself after an earlier one is gone', () => {
		const [a, b, c] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		const list = [a, b, c];
		// A second table copy removes `a`; the first copy still has `b` at index 1.
		expect(removeEntry(list, a)).toBe(true);
		expect(removeEntry(list, b)).toBe(true);
		expect(list).toEqual([c]);
	});

	it('does nothing for an entry that is already gone', () => {
		const [a, b] = [{ id: 'a' }, { id: 'b' }];
		const list = [b];
		expect(removeEntry(list, a)).toBe(false);
		expect(list).toEqual([b]);
	});
});
