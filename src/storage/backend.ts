// The StorageBackend seam: the one production interface every storage provider
// implements, and the type every Phase 1/2 module codes against.
//
// The signature is the kept-seed shape from the transport spike charter (put /
// get / head / delete / list, stream-shaped), graduated verbatim. This file
// fills in the parts the charter left abstract and adds strictly-additive
// optionals so the seam is backward compatible with the charter signature:
//   - `ListPage` / `Capabilities` were named but not defined by the charter.
//   - `put` gains a trailing optional `opts` (checksum + metadata + content
//     type) so the offload pipeline can do a checksummed PUT (spec section 10
//     F1 rung 1) and write the disaster-recovery object metadata (spec
//     section 3). A caller using the bare charter `put(key, body, size)` still
//     type-checks.
//   - `head` / `GetResult` expose the optional provider sha256 (spec section 6
//     content-verified tier).
//   - `displayKey` is the "native display key" the spec section 3 requires so
//     each backend maps identity to its own browsable namespace (access axis).
//
// Discipline (spec section 3): before a primitive enters this interface, the
// local-folder backend must be able to satisfy it. `etag` is treated as an
// opaque change-detection token, never identity (a local backend can return
// mtime+size); `checksumSha256` is optional precisely because not every backend
// can validate bytes server-side.

// --- capability flags (two axes, spec section 3) ----------------------------

// What the backend can DO with an upload.
export interface UploadCapabilities {
	presign: boolean; // can mint a presigned URL for direct transfer
	range: boolean; // honours a byte-range GET (206)
	serverChecksum: boolean; // validates x-amz-checksum-sha256 on PUT and returns it on HEAD/GET
	conditionalWrite: boolean; // honours If-Match / If-None-Match (destructive-op guard)
}

// How the user REACHES and opens an object. presigned-url = S3 (presign / S3
// browser); local-path = a sync folder (OS file explorer, no presign);
// native-app = a provider's own app (e.g. OneDrive).
export type AccessModel = 'presigned-url' | 'local-path' | 'native-app';

export interface Capabilities {
	upload: UploadCapabilities;
	access: AccessModel;
}

// --- request / response shapes ----------------------------------------------

// A body is bytes in hand, a Blob, or a stream. Tier-0 callers pass bytes or a
// Blob; the stream form keeps the seam ready for the measured large-file path.
export type PutBody = Uint8Array | Blob | ReadableStream<Uint8Array>;

export interface PutOptions {
	// base64 sha256 of the body. With a serverChecksum backend the server
	// validates received bytes against it and rejects a mismatch, so a 2xx PUT
	// is content-verification with no re-download (spec section 10 F1 rung 1).
	checksumSha256?: string;
	// x-amz-meta-* on S3: the disaster-recovery spine (full sha256, original
	// path/name/size, content type). Spec section 3.
	metadata?: Record<string, string>;
	contentType?: string;
}

export interface PutResult {
	etag: string; // opaque change-detection token, never identity
	checksumSha256?: string; // server-confirmed base64 sha256, when the backend validated it
}

export interface HeadResult {
	size: number;
	etag: string;
	checksumSha256?: string;
	lastModified?: string;
	metadata?: Record<string, string>;
}

export interface GetRange {
	start: number;
	end: number; // inclusive, HTTP Range semantics
}

export interface GetResult {
	status: number; // 200 full | 206 partial
	stream(): ReadableStream<Uint8Array>;
	arrayBuffer(): Promise<ArrayBuffer>; // convenience; backend decides buffer vs drain
	contentRange?: string; // e.g. "bytes 0-511/2048" on a 206
	checksumSha256?: string;
}

export interface ListEntry {
	key: string;
	size: number;
	etag: string;
	lastModified?: string;
}

export interface ListOptions {
	delimiter?: string; // groups keys into commonPrefixes (folder-like listing)
	cursor?: string; // continuation token from a prior page
	maxKeys?: number; // page size
}

export interface ListPage {
	entries: ListEntry[];
	commonPrefixes: string[];
	isTruncated: boolean;
	cursor: string | null; // continuation token for the next page, or null when exhausted
}

export interface StorageBackend {
	readonly capabilities: Capabilities;
	put(key: string, body: PutBody, size: number, opts?: PutOptions): Promise<PutResult>;
	get(key: string, range?: GetRange): Promise<GetResult>;
	head(key: string): Promise<HeadResult>;
	delete(key: string): Promise<void>;
	list(prefix?: string, opts?: ListOptions): Promise<ListPage>;
	// The browsable form of a key for this backend's access model (spec section 3).
	displayKey(key: string): string;
}

// --- typed errors -----------------------------------------------------------

// Why an operation failed, distinct from a bare Error so callers can branch:
// the offload pipeline must keep the local original on `auth` (dead creds, no
// HEAD, no delete - spec section 10 worst-day) and surface a real
// `checksum-mismatch` rather than silently deleting.
export type BackendErrorKind =
	| 'not-found'
	| 'network'
	| 'auth'
	| 'checksum-mismatch'
	| 'precondition-failed'
	| 'injected';

export class BackendError extends Error {
	readonly kind: BackendErrorKind;
	constructor(kind: BackendErrorKind, message: string) {
		super(message);
		this.name = 'BackendError';
		this.kind = kind;
	}
}

export class ObjectNotFoundError extends BackendError {
	constructor(key: string) {
		super('not-found', `object not found: ${key}`);
		this.name = 'ObjectNotFoundError';
	}
}
