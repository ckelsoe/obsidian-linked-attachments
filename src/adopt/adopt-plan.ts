import { AdoptRow, AdoptedPointer, AdoptOptions, buildAdoptedPointer } from './adopt-scan';

// The adopt UI's safety guard over the proven engine. planAdoption builds a pointer
// only for rows that are actually adoptable, so a collision or already-adopted row
// can never become a pointer even if the checklist offers it - the "never overwrite,
// never double-adopt" rule is enforced here, not trusted to the modal.

export interface AdoptSummary {
	total: number;
	adoptable: number;
	collision: number;
	alreadyAdopted: number;
}

export function planAdoption(rows: AdoptRow[], options: AdoptOptions): AdoptedPointer[] {
	return rows.filter((row) => row.status === 'adoptable').map((row) => buildAdoptedPointer(row, options));
}

export function summarizeRows(rows: AdoptRow[]): AdoptSummary {
	return {
		total: rows.length,
		adoptable: rows.filter((r) => r.status === 'adoptable').length,
		collision: rows.filter((r) => r.status === 'collision').length,
		alreadyAdopted: rows.filter((r) => r.status === 'already-adopted').length,
	};
}
