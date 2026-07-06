import { PointerRecord, requireS3Backend } from '../pointer/codec';
import { supersedingKey } from '../key/layout';
import { conflictCopyName } from './lock-manager';

// The check-in decision (spec section 4a). Check-in is ALWAYS additive: a changed
// file produces a NEW content-addressed object (new key) and the prior object is
// retained - there is NO replace at check-in (pruning a prior version is a separate
// confirmed GC op, out of scope). Three outcomes:
//
//   - no-op:    the working copy is unchanged from what was checked out (nothing to
//               upload; just release the lock and discard the working copy).
//   - version:  the working copy was edited and the cloud version is unchanged since
//               checkout - a clean new version superseding the prior key.
//   - conflict: the working copy was edited AND the cloud version advanced since
//               checkout (another device checked in). Still additive/LWW: a new
//               version superseding the CURRENT cloud version, so both diverged
//               versions survive in the bucket/chain. The current cloud version is
//               also preserved as a visible .conflict copy (the version browser is
//               deferred), so the conflict is never silent. Never a merge engine.
//
// The pointer NOTE id is stable across versions (it is the lineage anchor); the
// supersedes field links to the immediately-prior version's key.

export interface CheckinPlanInput {
	record: PointerRecord; // the CURRENT pointer record (may have advanced via sync)
	workingHash: string; // sha256 of the edited working copy now
	workingSize: number;
	checkoutBaseHash: string; // the hash the working copy was based on (checkout time)
	vaultPrefix: string;
	now: () => string;
}

export type CheckinPlan =
	| { kind: 'no-op' }
	| { kind: 'version'; record: PointerRecord }
	| { kind: 'conflict'; record: PointerRecord; conflictName: string; conflictSourceKey: string };

export function planCheckin(input: CheckinPlanInput): CheckinPlan {
	const { record, workingHash, checkoutBaseHash } = input;

	// Unchanged working copy: nothing to contribute, even if the cloud advanced.
	if (workingHash === checkoutBaseHash) {
		return { kind: 'no-op' };
	}

	const newRecord = supersedingRecord(input);
	// The cloud version advanced under us (the current pointer hash differs from what
	// we checked out): a conflict. Still additive (LWW), plus a visible preservation.
	if (record.hash !== checkoutBaseHash) {
		return {
			kind: 'conflict',
			record: newRecord,
			conflictName: conflictCopyName(record.originalName, 'another-device', input.now()),
			conflictSourceKey: requireS3Backend(record).key,
		};
	}
	return { kind: 'version', record: newRecord };
}

// --- internals --------------------------------------------------------------

function supersedingRecord(input: CheckinPlanInput): PointerRecord {
	const { record, workingHash, workingSize } = input;
	const s3 = requireS3Backend(record);
	const { key, supersedes } = supersedingKey(
		{ vaultPrefix: input.vaultPrefix, originalPath: record.originalPath, hash: workingHash },
		s3.key,
	);
	// Check-in versions the S3 object. A local mirror (if any) still holds the prior
	// bytes, so it is not carried onto the new version; re-mirroring is the "add
	// local mirror" migration command's job, not check-in's.
	return {
		...record,
		hash: workingHash,
		backends: [{ type: 's3', bucket: s3.bucket, key, keyKind: 'hash' }],
		byteSize: workingSize,
		// Reset to asserted; the manager sets the achieved tier after the PUT verifies.
		verificationTier: 'asserted',
		remoteChecksum: null,
		copyState: 'offloaded', // checked back in
		supersedes, // = the prior version's key (the immediate predecessor)
		sourceVersion: record.hash, // the version this one was derived from
		offloadedAt: input.now(),
	};
}
