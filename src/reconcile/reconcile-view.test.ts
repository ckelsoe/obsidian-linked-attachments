import { summarizeFindings, outcomeCopy } from './reconcile-view';
import { ReconcileFinding, ReconcileOutcome } from './scanner';

// The view-model for the reconciliation results (spec section 6, dev-plan section 8:
// "the four outcomes with felt copy"). Pure so the counts and the plain-language copy
// are testable. The honesty rule: only the unlinked outcome offers an action ("link
// it"); broken and drift are flagged, never auto-remediated in v1.

const finding = (outcome: ReconcileOutcome, key: string): ReconcileFinding => ({
	outcome,
	key,
	pointer: null,
	object: null,
	stampedTier: null,
	detail: '',
});

describe('summarizeFindings', () => {
	it('counts each outcome', () => {
		const findings = [
			finding('healthy', 'a'),
			finding('healthy', 'b'),
			finding('broken', 'c'),
			finding('unlinked', 'd'),
			finding('drift', 'e'),
		];
		expect(summarizeFindings(findings)).toEqual({ total: 5, healthy: 2, broken: 1, unlinked: 1, drift: 1 });
	});

	it('is all zeros for no findings', () => {
		expect(summarizeFindings([])).toEqual({ total: 0, healthy: 0, broken: 0, unlinked: 0, drift: 0 });
	});
});

describe('outcomeCopy', () => {
	it('every outcome has a non-empty title and felt line', () => {
		for (const outcome of ['healthy', 'broken', 'unlinked', 'drift'] as ReconcileOutcome[]) {
			const copy = outcomeCopy(outcome);
			expect(copy.title.length).toBeGreaterThan(0);
			expect(copy.felt.length).toBeGreaterThan(0);
		}
	});

	it('only the unlinked outcome can be acted on (link it)', () => {
		expect(outcomeCopy('unlinked').canAct).toBe(true);
		expect(outcomeCopy('healthy').canAct).toBe(false);
		expect(outcomeCopy('broken').canAct).toBe(false);
		expect(outcomeCopy('drift').canAct).toBe(false);
	});
});
