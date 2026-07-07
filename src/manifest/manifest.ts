import { KeyKind, PointerRecord, s3Backend, VerificationTier } from '../pointer/codec';

// The manifest cache (spec section 3, section 10). A fast index of every
// offloaded object, REBUILDABLE and never the source of truth:
//
//   - Authoritative rebuild: scan the vault's pointer files
//     (buildManifestFromPointers). Pointers win every conflict.
//   - Recovery rebuild: ListObjects + read object metadata
//     (buildManifestFromBucket). Used when the pointers are unavailable.
//   - The persisted manifest is OUTPUT, never INPUT of recovery: a corrupt copy
//     is discarded (parseManifest returns a discardable result, never throws,
//     never yields a partial manifest) and rebuilt from pointers > LIST.
//
// Ordering of trust: pointers > LIST > any manifest copy.

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

const KEY_KINDS: readonly KeyKind[] = ['hash', 'external'];
const VERIFICATION_TIERS: readonly VerificationTier[] = ['content', 'md5', 'existence', 'asserted'];

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

export function buildManifestFromPointers(sources: PointerSource[]): Manifest {
	const entries: Record<string, ManifestEntry> = {};
	for (const { pointerPath, record } of sources) {
		// The manifest indexes the S3 object (LIST/HEAD reconcile is S3-side). A
		// local-only pointer has no S3 object to reconcile against the bucket, so it
		// is skipped here; local integrity is checked on the pointer's local backend.
		const s3 = s3Backend(record);
		if (s3 === null) {
			continue;
		}
		// Duplicate keys resolve deterministically: last source wins.
		entries[s3.key] = {
			key: s3.key,
			keyKind: s3.keyKind,
			id: record.id,
			hash: record.hash,
			bucket: s3.bucket,
			byteSize: record.byteSize,
			verificationTier: record.verificationTier,
			originalPath: record.originalPath,
			pointerPath,
			remoteChecksum: record.remoteChecksum,
		};
	}
	return { version: MANIFEST_VERSION, entries };
}

export function buildManifestFromBucket(bucket: string, objects: BucketObject[]): Manifest {
	const entries: Record<string, ManifestEntry> = {};
	for (const object of objects) {
		const metadata = object.metadata ?? {};
		const hash = readMeta(metadata, OBJECT_METADATA_KEYS.sha256);
		entries[object.key] = {
			key: object.key,
			// Our objects carry a sha256 in metadata; a foreign object has none.
			keyKind: hash !== null ? 'hash' : 'external',
			id: readMeta(metadata, OBJECT_METADATA_KEYS.id) ?? '',
			hash,
			bucket,
			byteSize: object.byteSize,
			// LIST/HEAD only locate the object; bytes are not re-checked, so the
			// strongest tier a bucket rebuild can claim is asserted (spec section 6).
			verificationTier: 'asserted',
			originalPath: readMeta(metadata, OBJECT_METADATA_KEYS.originalPath) ?? '',
			pointerPath: null,
			remoteChecksum: object.remoteChecksum ?? null,
		};
	}
	return { version: MANIFEST_VERSION, entries };
}

// Overlay authoritative (pointer-derived) entries onto a cached manifest:
// per-key, the pointer wins (spec section 10).
export function mergeManifests(cached: Manifest, authoritative: Manifest): Manifest {
	return {
		version: MANIFEST_VERSION,
		entries: { ...cached.entries, ...authoritative.entries },
	};
}

export function serializeManifest(manifest: Manifest): string {
	return JSON.stringify(manifest);
}

export function parseManifest(text: string): ManifestParseResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, reason: 'manifest is not valid JSON' };
	}
	if (!isRecord(raw) || typeof raw.version !== 'number' || !isRecord(raw.entries)) {
		return { ok: false, reason: 'manifest has an unexpected shape' };
	}
	const entries: Record<string, ManifestEntry> = {};
	for (const [key, value] of Object.entries(raw.entries)) {
		const entry = validateEntry(value);
		if (entry === null) {
			return { ok: false, reason: `manifest entry ${key} is malformed` };
		}
		entries[key] = entry;
	}
	return { ok: true, manifest: { version: raw.version, entries } };
}

export function findByKey(manifest: Manifest, key: string): ManifestEntry | null {
	return manifest.entries[key] ?? null;
}

export function findByHash(manifest: Manifest, hash: string): ManifestEntry[] {
	return Object.values(manifest.entries).filter((entry) => entry.hash === hash);
}

export function hasKey(manifest: Manifest, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(manifest.entries, key);
}

// --- internals --------------------------------------------------------------

function readMeta(metadata: Record<string, string>, key: string): string | null {
	const value = metadata[key];
	return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateEntry(value: unknown): ManifestEntry | null {
	if (!isRecord(value)) {
		return null;
	}
	if (
		typeof value.key !== 'string' ||
		!isMember(value.keyKind, KEY_KINDS) ||
		typeof value.id !== 'string' ||
		!isStringOrNull(value.hash) ||
		typeof value.bucket !== 'string' ||
		typeof value.byteSize !== 'number' ||
		!Number.isFinite(value.byteSize) ||
		!isMember(value.verificationTier, VERIFICATION_TIERS) ||
		typeof value.originalPath !== 'string' ||
		!isStringOrNull(value.pointerPath) ||
		!isStringOrNull(value.remoteChecksum)
	) {
		return null;
	}
	return {
		key: value.key,
		keyKind: value.keyKind,
		id: value.id,
		hash: value.hash,
		bucket: value.bucket,
		byteSize: value.byteSize,
		verificationTier: value.verificationTier,
		originalPath: value.originalPath,
		pointerPath: value.pointerPath,
		remoteChecksum: value.remoteChecksum,
	};
}

function isStringOrNull(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
