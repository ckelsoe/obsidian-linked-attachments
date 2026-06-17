import { KeyKind, PointerRecord, VerificationTier } from '../pointer/codec';

// STUB (la-p1-05 RED). Implementation lands in the GREEN commit.

export const MANIFEST_VERSION = 1;

// The x-amz-meta-* names the plugin writes on offload and reads back when
// rebuilding the manifest from the bucket. S3 lowercases user-metadata keys, so
// these are all lowercase. One source of truth shared with the offload pipeline.
export const OBJECT_METADATA_KEYS = {
	sha256: 'sha256',
	id: 'id',
	originalPath: 'originalpath',
	originalName: 'originalname',
	byteSize: 'bytesize',
	contentType: 'contenttype',
} as const;

export interface ManifestEntry {
	key: string;
	keyKind: KeyKind;
	id: string;
	hash: string | null;
	bucket: string;
	byteSize: number;
	verificationTier: VerificationTier;
	originalPath: string;
	pointerPath: string | null;
	remoteChecksum: string | null;
}

export interface Manifest {
	version: number;
	entries: Record<string, ManifestEntry>;
}

export interface PointerSource {
	pointerPath: string;
	record: PointerRecord;
}

export interface BucketObject {
	key: string;
	byteSize: number;
	metadata?: Record<string, string>;
	remoteChecksum?: string | null;
}

export type ManifestParseResult = { ok: true; manifest: Manifest } | { ok: false; reason: string };

export function buildManifestFromPointers(_sources: PointerSource[]): Manifest {
	throw new Error('not implemented');
}

export function buildManifestFromBucket(_bucket: string, _objects: BucketObject[]): Manifest {
	throw new Error('not implemented');
}

export function mergeManifests(_cached: Manifest, _authoritative: Manifest): Manifest {
	throw new Error('not implemented');
}

export function serializeManifest(_manifest: Manifest): string {
	throw new Error('not implemented');
}

export function parseManifest(_text: string): ManifestParseResult {
	throw new Error('not implemented');
}

export function findByKey(_manifest: Manifest, _key: string): ManifestEntry | null {
	throw new Error('not implemented');
}

export function findByHash(_manifest: Manifest, _hash: string): ManifestEntry[] {
	throw new Error('not implemented');
}

export function hasKey(_manifest: Manifest, _key: string): boolean {
	throw new Error('not implemented');
}
