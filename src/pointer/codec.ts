import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { MANAGED_END, MANAGED_START, renderManagedBlock } from './managed-block';

// The pointer-md codec (spec section 5). A pointer note has three regions:
//
//   ---
//   <la_* frontmatter>      machine fields, plugin-owned, this codec's domain
//   ---
//   <managed block>         regenerable open link, between the markers
//   <user body>             100% user-owned; this codec never writes here
//
// Identity is read from frontmatter only (the R14 scanner and restore depend on
// this), so the body is always safe to edit and the managed link is never
// authoritative. The codec is pure: js-yaml for frontmatter, plain string
// surgery for the block and body, no `obsidian` import, no network.

export type KeyKind = 'hash' | 'external';
export type VerificationTier = 'content' | 'md5' | 'existence' | 'asserted';
export type BackendType = 's3' | 'local';

const KEY_KINDS: readonly KeyKind[] = ['hash', 'external'];
const VERIFICATION_TIERS: readonly VerificationTier[] = ['content', 'md5', 'existence', 'asserted'];

// The current pointer schema version. v1 = the flat la_bucket/la_key/la_key_kind
// shape (a single implicit S3 backend). v2 = the la_backends list below, which
// lets one object be held by several backends (S3, a local folder, and future
// backends) in read-preference order. decodePointer reads both; encodePointer
// always writes v2.
export const LA_VERSION = 2;

// One backend that holds the object, addressed in that backend's own namespace.
// A discriminated union so a new backend (e.g. a native cloud API) is added by
// extending BackendRef and the codec, not by widening a flat field. The list on
// a PointerRecord is ORDERED: the first entry is the preferred read path, the
// rest are fallbacks (spec section 3 access axis).
export interface S3BackendRef {
	type: 's3';
	bucket: string;
	key: string;
	keyKind: KeyKind;
}
export interface LocalBackendRef {
	type: 'local';
	// Forward-slash path relative to the user's configured local root, resolved
	// against that root at read time (root-relative portability: the same pointer
	// works on two machines that mount the synced folder at different absolute
	// paths). Usually identical to the S3 key for a paired object.
	path: string;
}
export type BackendRef = S3BackendRef | LocalBackendRef;

// The in-memory form of a pointer note's machine fields. Nullable fields are
// null for foreign adopted objects (hash) and single-part / non-multipart
// uploads (remoteChecksum, partSize, partCount, supersedes).
export interface PointerRecord {
	laVersion: number;
	id: string;
	hash: string | null;
	// Every backend that currently holds this object, in read-preference order.
	// Always at least one entry (a pointer with zero valid backends is never
	// written - spec section 3 exit guarantee).
	backends: BackendRef[];
	originalName: string;
	originalExt: string;
	originalPath: string;
	byteSize: number;
	contentType: string;
	copyState: string;
	verificationTier: VerificationTier;
	remoteChecksum: string | null;
	checksumAlgo: string | null;
	partSize: number | null;
	partCount: number | null;
	offloadedAt: string;
	sourceVersion: string | null;
	supersedes: string | null;
}

export interface DecodedPointer {
	record: PointerRecord;
	body: string;
	// Any frontmatter keys the codec does not own (e.g. user tags, or a future
	// la_* field this version does not know). Preserved verbatim on re-encode.
	extraFrontmatter: Record<string, unknown>;
}

export class PointerParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PointerParseError';
	}
}

// The frontmatter key for each record field. The single source of truth for the
// `la_*` namespace; also defines the "known keys" set that separates machine
// fields from preserved extras.
const FRONTMATTER_KEYS = {
	laVersion: 'la_version',
	id: 'la_id',
	hash: 'la_hash',
	backends: 'la_backends',
	originalName: 'la_original_name',
	originalExt: 'la_original_ext',
	originalPath: 'la_original_path',
	byteSize: 'la_byte_size',
	contentType: 'la_content_type',
	copyState: 'la_copy_state',
	verificationTier: 'la_verification_tier',
	remoteChecksum: 'la_remote_checksum',
	checksumAlgo: 'la_checksum_algo',
	partSize: 'la_part_size',
	partCount: 'la_part_count',
	offloadedAt: 'la_offloaded_at',
	sourceVersion: 'la_source_version',
	supersedes: 'la_supersedes',
} as const;

// The v1 flat backend keys. Not written anymore (encode emits la_backends), but
// listed as "known" so a v1 pointer's flat keys are consumed on decode rather
// than preserved as extras and duplicated back on re-encode.
const LEGACY_BACKEND_KEYS = {
	bucket: 'la_bucket',
	key: 'la_key',
	keyKind: 'la_key_kind',
} as const;

const KNOWN_FRONTMATTER_KEYS = new Set<string>([...Object.values(FRONTMATTER_KEYS), ...Object.values(LEGACY_BACKEND_KEYS)]);

const FENCE = '---\n';

// The extension is the substring after the LAST dot (spec section 5 multi-dot
// rule): "a.b.tar.gz" -> "gz", not "tar.gz". A leading-dot dotfile (".env") and a
// trailing dot ("name.") both yield "" - there is no extension segment.
export function extractExtension(name: string): string {
	const dot = name.lastIndexOf('.');
	if (dot <= 0) {
		return '';
	}
	return name.slice(dot + 1);
}

// --- backend accessors ------------------------------------------------------

// The S3 backend on a pointer, or null if it has none (a local-only pointer).
export function s3Backend(record: PointerRecord): S3BackendRef | null {
	return record.backends.find((backend): backend is S3BackendRef => backend.type === 's3') ?? null;
}

// The local backend on a pointer, or null if it has none (an S3-only pointer).
export function localBackend(record: PointerRecord): LocalBackendRef | null {
	return record.backends.find((backend): backend is LocalBackendRef => backend.type === 'local') ?? null;
}

// The S3 backend on a pointer, asserting it has one. For code paths that are
// inherently S3 (multipart, presign, the S3 reconcile scan); a local-only
// pointer reaching one of these is a programming error, surfaced as such.
export function requireS3Backend(record: PointerRecord): S3BackendRef {
	const s3 = s3Backend(record);
	if (s3 === null) {
		throw new PointerParseError('pointer has no S3 backend');
	}
	return s3;
}

// The preferred read backend: the first entry, in read-preference order. A record
// always carries at least one backend; a caller that cannot prove that to the
// type system gets a typed error rather than an undefined.
export function preferredBackend(record: PointerRecord): BackendRef {
	const first = record.backends[0];
	if (first === undefined) {
		throw new PointerParseError('pointer has no backends');
	}
	return first;
}

export function encodePointer(record: PointerRecord, body: string, extraFrontmatter?: Record<string, unknown>): string {
	const frontmatter: Record<string, unknown> = {
		[FRONTMATTER_KEYS.laVersion]: record.laVersion,
		[FRONTMATTER_KEYS.id]: record.id,
		[FRONTMATTER_KEYS.hash]: record.hash,
		[FRONTMATTER_KEYS.backends]: record.backends.map(backendToYaml),
		[FRONTMATTER_KEYS.originalName]: record.originalName,
		[FRONTMATTER_KEYS.originalExt]: record.originalExt,
		[FRONTMATTER_KEYS.originalPath]: record.originalPath,
		[FRONTMATTER_KEYS.byteSize]: record.byteSize,
		[FRONTMATTER_KEYS.contentType]: record.contentType,
		[FRONTMATTER_KEYS.copyState]: record.copyState,
		[FRONTMATTER_KEYS.verificationTier]: record.verificationTier,
		[FRONTMATTER_KEYS.remoteChecksum]: record.remoteChecksum,
		[FRONTMATTER_KEYS.checksumAlgo]: record.checksumAlgo,
		[FRONTMATTER_KEYS.partSize]: record.partSize,
		[FRONTMATTER_KEYS.partCount]: record.partCount,
		[FRONTMATTER_KEYS.offloadedAt]: record.offloadedAt,
		[FRONTMATTER_KEYS.sourceVersion]: record.sourceVersion,
		[FRONTMATTER_KEYS.supersedes]: record.supersedes,
		...(extraFrontmatter ?? {}),
	};
	// lineWidth -1 disables line folding so long paths stay on one line; quotes are
	// added implicitly for any value that would otherwise re-parse as a non-string
	// (timestamps, "yes"/"no", numbers), keeping every string a string on decode.
	const frontmatterText = dumpYaml(frontmatter, { lineWidth: -1 });
	const block = renderManagedBlock({ id: record.id, originalName: record.originalName });
	return `${FENCE}${frontmatterText}${FENCE}${block}\n${body}`;
}

export function decodePointer(text: string): DecodedPointer {
	if (!text.startsWith(FENCE)) {
		throw new PointerParseError('not a pointer: file does not begin with a frontmatter fence');
	}
	const closingNewline = text.indexOf(`\n${FENCE}`, FENCE.length - 1);
	if (closingNewline < 0) {
		throw new PointerParseError('not a pointer: the frontmatter fence is never closed');
	}
	const frontmatterText = text.slice(FENCE.length, closingNewline + 1);
	const rest = text.slice(closingNewline + 1 + FENCE.length);

	let parsed: unknown;
	try {
		parsed = loadYaml(frontmatterText);
	} catch (error) {
		throw new PointerParseError(`frontmatter is not valid YAML: ${describe(error)}`);
	}
	if (!isPlainObject(parsed)) {
		throw new PointerParseError('frontmatter is not a mapping');
	}

	const record = buildRecord(parsed);
	const extraFrontmatter = extractExtras(parsed);
	const body = extractBody(rest);
	return { record, body, extraFrontmatter };
}

// Regenerate only the managed block, leaving frontmatter and body byte-identical.
// Used when a pointer's display fields change (e.g. an Obsidian rename) without
// touching identity.
export function refreshManagedBlock(text: string, record: PointerRecord): string {
	const span = locateManagedBlock(text);
	const block = renderManagedBlock({ id: record.id, originalName: record.originalName });
	return text.slice(0, span.start) + block + text.slice(span.end);
}

// --- internals --------------------------------------------------------------

interface BlockSpan {
	start: number; // index of MANAGED_START
	end: number; // index just past MANAGED_END
}

function locateManagedBlock(text: string): BlockSpan {
	const starts = countOccurrences(text, MANAGED_START);
	const ends = countOccurrences(text, MANAGED_END);
	if (starts !== 1 || ends !== 1) {
		throw new PointerParseError(`expected exactly one managed block, found ${starts} start / ${ends} end markers`);
	}
	const start = text.indexOf(MANAGED_START);
	const endMarker = text.indexOf(MANAGED_END);
	if (start > endMarker) {
		throw new PointerParseError('managed block end marker precedes its start marker');
	}
	return { start, end: endMarker + MANAGED_END.length };
}

function extractBody(rest: string): string {
	const span = locateManagedBlock(rest);
	const after = rest.slice(span.end);
	// encode joins the block to the body with a single newline; strip exactly that
	// separator so the body round-trips byte-for-byte.
	return after.startsWith('\n') ? after.slice(1) : after;
}

function buildRecord(fm: Record<string, unknown>): PointerRecord {
	return {
		laVersion: requireNumber(fm, FRONTMATTER_KEYS.laVersion),
		id: requireString(fm, FRONTMATTER_KEYS.id),
		hash: nullableString(fm, FRONTMATTER_KEYS.hash),
		backends: parseBackends(fm),
		originalName: requireString(fm, FRONTMATTER_KEYS.originalName),
		originalExt: requireString(fm, FRONTMATTER_KEYS.originalExt),
		originalPath: requireString(fm, FRONTMATTER_KEYS.originalPath),
		byteSize: requireNumber(fm, FRONTMATTER_KEYS.byteSize),
		contentType: requireString(fm, FRONTMATTER_KEYS.contentType),
		copyState: requireString(fm, FRONTMATTER_KEYS.copyState),
		verificationTier: requireEnum(fm, FRONTMATTER_KEYS.verificationTier, VERIFICATION_TIERS),
		remoteChecksum: nullableString(fm, FRONTMATTER_KEYS.remoteChecksum),
		checksumAlgo: nullableString(fm, FRONTMATTER_KEYS.checksumAlgo),
		partSize: nullableNumber(fm, FRONTMATTER_KEYS.partSize),
		partCount: nullableNumber(fm, FRONTMATTER_KEYS.partCount),
		offloadedAt: requireString(fm, FRONTMATTER_KEYS.offloadedAt),
		sourceVersion: nullableString(fm, FRONTMATTER_KEYS.sourceVersion),
		supersedes: nullableString(fm, FRONTMATTER_KEYS.supersedes),
	};
}

function backendToYaml(backend: BackendRef): Record<string, unknown> {
	if (backend.type === 's3') {
		return { type: 's3', bucket: backend.bucket, key: backend.key, key_kind: backend.keyKind };
	}
	return { type: 'local', path: backend.path };
}

function parseBackends(fm: Record<string, unknown>): BackendRef[] {
	const raw = fm[FRONTMATTER_KEYS.backends];
	if (raw === undefined) {
		// v1 back-compat: no la_backends means the flat la_bucket/la_key/la_key_kind
		// described a single implicit S3 backend. Synthesize it so an existing
		// S3-only pointer decodes unchanged, with no migration step.
		return [
			{
				type: 's3',
				bucket: requireString(fm, LEGACY_BACKEND_KEYS.bucket),
				key: requireString(fm, LEGACY_BACKEND_KEYS.key),
				keyKind: requireEnum(fm, LEGACY_BACKEND_KEYS.keyKind, KEY_KINDS),
			},
		];
	}
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new PointerParseError(`field ${FRONTMATTER_KEYS.backends} must be a non-empty list of backends`);
	}
	return raw.map((entry, index) => parseBackendEntry(entry, index));
}

function parseBackendEntry(entry: unknown, index: number): BackendRef {
	if (!isPlainObject(entry)) {
		throw new PointerParseError(`backend #${index} is not a mapping`);
	}
	const type = entry.type;
	if (type === 's3') {
		return {
			type: 's3',
			bucket: requireBackendString(entry, 'bucket', index),
			key: requireBackendString(entry, 'key', index),
			keyKind: parseKeyKind(entry.key_kind, index),
		};
	}
	if (type === 'local') {
		return { type: 'local', path: requireBackendString(entry, 'path', index) };
	}
	throw new PointerParseError(`backend #${index} has unknown type ${String(type)}`);
}

function requireBackendString(entry: Record<string, unknown>, field: string, index: number): string {
	const value = entry[field];
	if (typeof value !== 'string' || value.length === 0) {
		throw new PointerParseError(`backend #${index} field ${field} is required and must be a non-empty string`);
	}
	return value;
}

function parseKeyKind(value: unknown, index: number): KeyKind {
	if (value === 'hash' || value === 'external') {
		return value;
	}
	throw new PointerParseError(`backend #${index} key_kind must be one of ${KEY_KINDS.join(', ')}`);
}

function extractExtras(fm: Record<string, unknown>): Record<string, unknown> {
	const extras: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fm)) {
		if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
			extras[key] = value;
		}
	}
	return extras;
}

function requireString(fm: Record<string, unknown>, key: string): string {
	const value = fm[key];
	// Obsidian's Properties UI unquotes a timestamp, which js-yaml's default schema
	// then parses as a Date. Coerce it back to the ISO string we wrote (tolerate the
	// reformatting rather than reject an equivalent value).
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (typeof value !== 'string') {
		throw new PointerParseError(`field ${key} is required and must be a string`);
	}
	return value;
}

function nullableString(fm: Record<string, unknown>, key: string): string | null {
	const value = fm[key];
	if (value === null || value === undefined) {
		return null;
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (typeof value !== 'string') {
		throw new PointerParseError(`field ${key} must be a string or null`);
	}
	return value;
}

function requireNumber(fm: Record<string, unknown>, key: string): number {
	const value = fm[key];
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new PointerParseError(`field ${key} is required and must be a number`);
	}
	return value;
}

function nullableNumber(fm: Record<string, unknown>, key: string): number | null {
	const value = fm[key];
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new PointerParseError(`field ${key} must be a number or null`);
	}
	return value;
}

function requireEnum<T extends string>(fm: Record<string, unknown>, key: string, allowed: readonly T[]): T {
	const value = requireString(fm, key);
	if (!(allowed as readonly string[]).includes(value)) {
		throw new PointerParseError(`field ${key} must be one of ${allowed.join(', ')}, got ${value}`);
	}
	return value as T;
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
