import { planCheckin, CheckinPlanInput } from './checkin';
import { PointerRecord } from '../pointer/codec';

// Tier 0: the check-in decision is pure. Check-in is ALWAYS additive (a changed
// file is a new content-addressed version; the prior object is retained), never a
// replace (spec section 4a). It detects three cases: no-op (unchanged), a clean new
// version, or a conflict (the cloud version advanced since checkout - LWW + preserve).

function record(overrides: Partial<PointerRecord> = {}): PointerRecord {
	return {
		laVersion: 1,
		id: 'ptr-1',
		hash: 'a'.repeat(64),
		bucket: 's3-dev-test',
		key: 'charles-main/budget--aaaaaa.xlsx',
		keyKind: 'hash',
		originalName: 'budget.xlsx',
		originalExt: 'xlsx',
		originalPath: 'finance/budget.xlsx',
		byteSize: 2048,
		contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		copyState: 'checked-out',
		verificationTier: 'content',
		remoteChecksum: null,
		checksumAlgo: 'sha256',
		partSize: null,
		partCount: null,
		offloadedAt: '2026-06-18T00:00:00.000Z',
		sourceVersion: null,
		supersedes: null,
		...overrides,
	};
}

function input(overrides: Partial<CheckinPlanInput> = {}): CheckinPlanInput {
	const rec = overrides.record ?? record();
	return {
		record: rec,
		workingHash: 'b'.repeat(64),
		workingSize: 4096,
		checkoutBaseHash: 'a'.repeat(64), // checked out from the v1 object
		vaultPrefix: 'charles-main',
		now: () => '2026-06-18T12:00:00.000Z',
		...overrides,
	};
}

describe('check-in planning (la-p6-31)', () => {
	// AC1 :: an unchanged working copy is a no-op (nothing to upload).
	it('test_no_op_when_unchanged', () => {
		const plan = planCheckin(input({ workingHash: 'a'.repeat(64) }));
		expect(plan.kind).toBe('no-op');
	});

	// AC2 :: an edited working copy with the cloud unchanged since checkout is a clean
	// new version: additive (new key), supersedes the prior key, keeps the pointer id.
	it('test_version_when_edited_clean', () => {
		const plan = planCheckin(input());
		expect(plan.kind).toBe('version');
		if (plan.kind === 'version') {
			expect(plan.record.hash).toBe('b'.repeat(64));
			expect(plan.record.key).not.toBe(record().key);
			expect(plan.record.supersedes).toBe(record().key);
			expect(plan.record.id).toBe('ptr-1'); // the pointer note (lineage anchor) is stable
			expect(plan.record.copyState).toBe('offloaded'); // checked back in
			expect(plan.record.verificationTier).toBe('asserted'); // until the PUT verifies
			expect(plan.record.byteSize).toBe(4096);
			expect(plan.record.sourceVersion).toBe('a'.repeat(64));
		}
	});

	// AC3 :: an edited working copy when the cloud version advanced since checkout is a
	// conflict: still additive/LWW (a new version superseding the CURRENT cloud key,
	// so both diverged versions survive), plus a recognizable .conflict copy to
	// preserve the superseded cloud version visibly. Never a merge.
	it('test_conflict_when_cloud_diverged', () => {
		// the pointer now points at a DIFFERENT current version than we checked out
		const diverged = record({ hash: 'c'.repeat(64), key: 'charles-main/budget--cccccc.xlsx' });
		const plan = planCheckin(input({ record: diverged, checkoutBaseHash: 'a'.repeat(64) }));
		expect(plan.kind).toBe('conflict');
		if (plan.kind === 'conflict') {
			expect(plan.record.supersedes).toBe('charles-main/budget--cccccc.xlsx'); // supersedes the CURRENT cloud version
			expect(plan.record.hash).toBe('b'.repeat(64));
			expect(plan.conflictSourceKey).toBe('charles-main/budget--cccccc.xlsx'); // the version to preserve visibly
			expect(plan.conflictName).toContain('conflict');
			expect(plan.conflictName.endsWith('.xlsx')).toBe(true);
		}
	});

	// AC4 :: an unchanged working copy is a no-op even if the cloud diverged (nothing
	// to contribute; the synced pointer already points at the newer version).
	it('test_no_op_precedence_over_conflict', () => {
		const diverged = record({ hash: 'c'.repeat(64) });
		const plan = planCheckin(input({ record: diverged, workingHash: 'a'.repeat(64), checkoutBaseHash: 'a'.repeat(64) }));
		expect(plan.kind).toBe('no-op');
	});

	// AC5 :: the new key is content-addressed from the working hash (additive).
	it('test_new_key_is_content_addressed', () => {
		const plan = planCheckin(input());
		if (plan.kind === 'version') {
			expect(plan.record.key).toContain('bbbbbb'); // short hash of the working bytes
			expect(plan.record.keyKind).toBe('hash');
		}
	});
});
