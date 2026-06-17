import { VerificationTier } from '../pointer/codec';
import { ListEntry, StorageBackend } from '../storage/backend';
import { ManifestEntry } from '../manifest/manifest';
import { AdoptedPointer, AdoptOptions, AdoptRow, buildAdoptedPointer, mirrorKeyToVaultPath } from '../adopt/adopt-scan';

// The reconciliation scanner (spec section 6): the moat made into a button. A
// bidirectional diff of vault pointers vs bucket objects into four outcomes:
//
//   healthy   pointer <-> object, identity matches -> mark, stamp a trust tier
//   broken    pointer, object missing             -> FLAG (remediation is v2)
//   unlinked  object, no pointer                  -> SURFACE + offer "link it"
//   drift     pointer + object, identity mismatch -> FLAG loudly (resolver is v2)
//
// Governing rule: surface, offer, flag - NEVER auto-destroy. v1 detects all four
// and acts on exactly one (link it). The scan issues only LIST (and HEAD when a
// deep checksum compare is requested); it never issues a put or delete.

export type ReconcileOutcome = 'healthy' | 'broken' | 'unlinked' | 'drift';

export interface BucketObjectInfo {
	key: string;
	size: number;
	etag: string;
	checksumSha256?: string;
}

export interface ReconcileFinding {
	outcome: ReconcileOutcome;
	key: string;
	pointer: ManifestEntry | null;
	object: BucketObjectInfo | null;
	stampedTier: VerificationTier | null;
	detail: string;
}

export interface ScanReconcileOptions {
	prefix?: string;
	deep?: boolean; // HEAD each object to compare checksums (costs a HEAD per object)
	pageSize?: number;
}

export interface LinkPlacement {
	stripPrefix?: string;
	destinationFolder?: string;
}

// Pure diff. No I/O.
export function reconcile(pointers: ManifestEntry[], objects: BucketObjectInfo[]): ReconcileFinding[] {
	const objectByKey = new Map(objects.map((object) => [object.key, object]));
	const pointerKeys = new Set(pointers.map((pointer) => pointer.key));
	const findings: ReconcileFinding[] = [];

	// Pointer side: healthy / broken / drift.
	for (const pointer of pointers) {
		const object = objectByKey.get(pointer.key);
		if (object === undefined) {
			findings.push({ outcome: 'broken', key: pointer.key, pointer, object: null, stampedTier: null, detail: 'pointer has no matching object in the bucket' });
			continue;
		}
		const drift = driftReason(pointer, object);
		if (drift !== null) {
			findings.push({ outcome: 'drift', key: pointer.key, pointer, object, stampedTier: null, detail: drift });
		} else {
			// Cheap LIST/HEAD confirmed the object is present at the expected size:
			// existence-verified. Content verification stays on-demand (spec section 6).
			findings.push({ outcome: 'healthy', key: pointer.key, pointer, object, stampedTier: 'existence', detail: 'identity matches (existence-verified)' });
		}
	}

	// Object side: unlinked candidates.
	for (const object of objects) {
		if (!pointerKeys.has(object.key)) {
			findings.push({ outcome: 'unlinked', key: object.key, pointer: null, object, stampedTier: null, detail: 'bucket object has no pointer' });
		}
	}

	return findings;
}

// Orchestrator: LIST under the prefix (optionally HEAD for checksums), then diff.
// Strictly read-only.
export async function scanReconcile(
	backend: StorageBackend,
	pointers: ManifestEntry[],
	options: ScanReconcileOptions = {},
): Promise<ReconcileFinding[]> {
	const prefix = options.prefix ?? '';
	const entries: ListEntry[] = [];
	let cursor: string | null = null;
	do {
		const page = await backend.list(prefix, { maxKeys: options.pageSize, cursor: cursor ?? undefined });
		entries.push(...page.entries);
		cursor = page.cursor;
	} while (cursor !== null);

	const objects: BucketObjectInfo[] = [];
	for (const entry of entries) {
		const info: BucketObjectInfo = { key: entry.key, size: entry.size, etag: entry.etag };
		if (options.deep === true) {
			const head = await backend.head(entry.key);
			info.checksumSha256 = head.checksumSha256;
		}
		objects.push(info);
	}

	return reconcile(pointers, objects);
}

// The single v1 remediation: build an adopted pointer for each unlinked
// candidate. Never touches broken or drift findings.
export function linkUnlinked(findings: ReconcileFinding[], placement: LinkPlacement, options: AdoptOptions): AdoptedPointer[] {
	const pointers: AdoptedPointer[] = [];
	for (const finding of findings) {
		if (finding.outcome !== 'unlinked' || finding.object === null) {
			continue;
		}
		const object = finding.object;
		const vaultPath = mirrorKeyToVaultPath(object.key, placement);
		const row: AdoptRow = {
			key: object.key,
			displayName: basename(vaultPath),
			size: object.size,
			vaultPath,
			pointerPath: `${vaultPath}.md`,
			status: 'adoptable',
		};
		pointers.push(buildAdoptedPointer(row, options));
	}
	return pointers;
}

// --- internals --------------------------------------------------------------

// Why a pointer and its object disagree, or null when they match. Size is the
// always-available cheap signal; a checksum mismatch is checked only when both
// sides carry one (the object's comes from a deep HEAD).
function driftReason(pointer: ManifestEntry, object: BucketObjectInfo): string | null {
	if (object.size !== pointer.byteSize) {
		return `size mismatch: pointer ${pointer.byteSize} vs object ${object.size}`;
	}
	if (object.checksumSha256 !== undefined && pointer.remoteChecksum !== null && object.checksumSha256 !== pointer.remoteChecksum) {
		return 'checksum mismatch (possible external overwrite)';
	}
	return null;
}

function basename(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? path.slice(slash + 1) : path;
}
