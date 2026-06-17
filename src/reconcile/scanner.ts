import { VerificationTier } from '../pointer/codec';
import { StorageBackend } from '../storage/backend';
import { ManifestEntry } from '../manifest/manifest';
import { AdoptedPointer, AdoptOptions } from '../adopt/adopt-scan';

// STUB (la-p2-10 RED). Implementation lands in the GREEN commit.

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
	deep?: boolean;
	pageSize?: number;
}

export interface LinkPlacement {
	stripPrefix?: string;
	destinationFolder?: string;
}

export function reconcile(_pointers: ManifestEntry[], _objects: BucketObjectInfo[]): ReconcileFinding[] {
	throw new Error('not implemented');
}

export function scanReconcile(
	_backend: StorageBackend,
	_pointers: ManifestEntry[],
	_options?: ScanReconcileOptions,
): Promise<ReconcileFinding[]> {
	throw new Error('not implemented');
}

export function linkUnlinked(_findings: ReconcileFinding[], _placement: LinkPlacement, _options: AdoptOptions): AdoptedPointer[] {
	throw new Error('not implemented');
}
