import { planAdoption, summarizeRows } from './adopt-plan';
import { AdoptRow } from './adopt-scan';

// The adopt UI's safety guard: a selection becomes pointers only for rows that are
// actually adoptable. Even if the checklist somehow offers a collision or an
// already-adopted row, planAdoption refuses to build a pointer for it - never
// overwrite, never double-adopt. Every built pointer is honestly ASSERTED.

const row = (key: string, status: AdoptRow['status']): AdoptRow => ({
	key,
	displayName: key,
	size: 10,
	vaultPath: `vault/${key}`,
	pointerPath: `vault/${key}.md`,
	status,
});

const options = { bucket: 'b', newId: () => 'id', now: () => '2026-06-17T00:00:00.000Z' };

describe('planAdoption', () => {
	it('AC1 test_builds_pointer_per_adoptable_row', () => {
		const pointers = planAdoption([row('a.pdf', 'adoptable'), row('b.pdf', 'adoptable')], options);
		expect(pointers).toHaveLength(2);
		expect(pointers.map((p) => p.pointerPath)).toEqual(['vault/a.pdf.md', 'vault/b.pdf.md']);
	});

	it('AC2 test_skips_non_adoptable :: collision and already-adopted never build', () => {
		const pointers = planAdoption(
			[row('a.pdf', 'adoptable'), row('b.pdf', 'collision'), row('c.pdf', 'already-adopted')],
			options,
		);
		expect(pointers.map((p) => p.record.key)).toEqual(['a.pdf']);
	});

	it('AC3 test_built_pointers_are_asserted', () => {
		const [pointer] = planAdoption([row('a.pdf', 'adoptable')], options);
		expect(pointer?.record.verificationTier).toBe('asserted');
		expect(pointer?.record.hash).toBeNull();
		expect(pointer?.record.keyKind).toBe('external');
	});

	it('AC4 test_empty_is_empty', () => {
		expect(planAdoption([], options)).toEqual([]);
	});
});

describe('summarizeRows', () => {
	it('counts each status for the modal header', () => {
		const rows = [
			row('a', 'adoptable'),
			row('b', 'adoptable'),
			row('c', 'collision'),
			row('d', 'already-adopted'),
		];
		expect(summarizeRows(rows)).toEqual({ total: 4, adoptable: 2, collision: 1, alreadyAdopted: 1 });
	});
});
