import { ReconcileFinding, ReconcileOutcome } from './scanner';

// The view-model for the reconciliation results view (spec section 6, dev-plan
// section 8). Pure: the per-outcome counts and the plain-language ("felt") copy live
// here so they are testable and consistent. The honesty rule is encoded as data:
// only the unlinked outcome carries canAct = true (the v1 "link it" action); broken
// and drift are flagged and shown, never auto-remediated.

export interface ReconcileSummary {
	total: number;
	healthy: number;
	broken: number;
	unlinked: number;
	drift: number;
}

export interface OutcomeCopy {
	title: string;
	felt: string;
	canAct: boolean;
}

export function summarizeFindings(findings: ReconcileFinding[]): ReconcileSummary {
	return {
		total: findings.length,
		healthy: findings.filter((f) => f.outcome === 'healthy').length,
		broken: findings.filter((f) => f.outcome === 'broken').length,
		unlinked: findings.filter((f) => f.outcome === 'unlinked').length,
		drift: findings.filter((f) => f.outcome === 'drift').length,
	};
}

const COPY: Record<ReconcileOutcome, OutcomeCopy> = {
	healthy: {
		title: 'Healthy',
		felt: 'Pointer and object agree. Your file is where it should be.',
		canAct: false,
	},
	broken: {
		title: 'Missing object',
		felt: 'This pointer has no file in the bucket. Nothing was deleted here - check whether another tool removed it.',
		canAct: false,
	},
	unlinked: {
		title: 'Not yet linked',
		felt: 'This object is in your bucket but has no pointer. Link it to bring it into your vault.',
		canAct: true,
	},
	drift: {
		title: 'Changed in the bucket',
		felt: 'The object no longer matches this pointer - something rewrote it. Both are shown; nothing was changed.',
		canAct: false,
	},
};

export function outcomeCopy(outcome: ReconcileOutcome): OutcomeCopy {
	return COPY[outcome];
}
