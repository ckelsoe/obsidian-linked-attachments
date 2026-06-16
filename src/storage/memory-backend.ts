import {
	BackendError,
	Capabilities,
	GetRange,
	GetResult,
	HeadResult,
	ListEntry,
	ListOptions,
	ListPage,
	ObjectNotFoundError,
	PutBody,
	PutOptions,
	PutResult,
	StorageBackend,
} from './backend';
import { sha256Base64 } from '../hash/sha256';

// An in-memory StorageBackend for tier-0 tests: the whole Phase 1/2 engine is
// exercised against it with no network (spec section 8). It is deliberately a
// faithful-enough S3 stand-in - server-side checksum validation, idempotent
// delete, prefix+delimiter+cursor listing - so the offload pipeline, F1
// verify-before-delete, adopt, and the reconciliation scanner can be proven
// before the real S3Backend exists.
//
// Two test seams beyond the StorageBackend interface:
//   - `faults`: a per-op hook a test sets to throw (network / dead-creds), to
//     drive O6 rollback and "no HEAD -> no delete" failure-injection cases.
//   - `seedObject`: plant arbitrary objects (foreign / metadata-less, or a
//     truncated body) to model externally-placed objects (adopt, reconcile) and
//     the dropped-PUT-reused-key path (re-verify-on-resume).

export type FaultOp = 'put' | 'get' | 'head' | 'delete' | 'list';
export type FaultHook = (key: string) => void;

export interface SeedOptions {
	metadata?: Record<string, string>;
	etag?: string;
	contentType?: string;
}

export interface MemoryBackendOptions {
	capabilities?: Capabilities;
}

interface StoredObject {
	bytes: Uint8Array;
	etag: string;
	checksumSha256: string;
	metadata: Record<string, string>;
	contentType?: string;
	lastModified: string;
}

const DEFAULT_CAPABILITIES: Capabilities = {
	upload: { presign: true, range: true, serverChecksum: true, conditionalWrite: true },
	access: 'presigned-url',
};

export class MemoryBackend implements StorageBackend {
	readonly capabilities: Capabilities;
	readonly faults: Partial<Record<FaultOp, FaultHook>> = {};

	private readonly store = new Map<string, StoredObject>();
	private etagCounter = 0;
	// A logical clock so lastModified is deterministic across test runs rather
	// than wall-clock (which would make ordering assertions flaky).
	private clock = 0;

	constructor(opts: MemoryBackendOptions = {}) {
		this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
	}

	async put(key: string, body: PutBody, size: number, opts: PutOptions = {}): Promise<PutResult> {
		this.trip('put', key);
		const bytes = await normalizeBody(body);
		if (size !== bytes.length) {
			// A declared size that disagrees with the body models a truncated or
			// over-declared upload; reject it rather than store a wrong-length object.
			throw new BackendError('network', `declared size ${size} != body length ${bytes.length} for ${key}`);
		}
		const checksumSha256 = await sha256Base64(bytes);
		if (opts.checksumSha256 !== undefined && this.capabilities.upload.serverChecksum) {
			if (opts.checksumSha256 !== checksumSha256) {
				// The server validated received bytes against the client checksum and
				// rejected the mismatch; nothing is stored (spec section 10 F1 rung 1).
				throw new BackendError('checksum-mismatch', `checksum mismatch for ${key}`);
			}
		}
		const etag = `"mem-${++this.etagCounter}"`;
		this.store.set(key, {
			bytes,
			etag,
			checksumSha256,
			metadata: { ...opts.metadata },
			contentType: opts.contentType,
			lastModified: this.nextTimestamp(),
		});
		return {
			etag,
			checksumSha256: this.capabilities.upload.serverChecksum ? checksumSha256 : undefined,
		};
	}

	async get(key: string, range?: GetRange): Promise<GetResult> {
		this.trip('get', key);
		const object = this.require(key);
		if (range !== undefined) {
			const slice = object.bytes.slice(range.start, range.end + 1);
			return makeGetResult(206, slice, `bytes ${range.start}-${range.end}/${object.bytes.length}`, object.checksumSha256);
		}
		return makeGetResult(200, object.bytes, undefined, object.checksumSha256);
	}

	async head(key: string): Promise<HeadResult> {
		this.trip('head', key);
		const object = this.require(key);
		return {
			size: object.bytes.length,
			etag: object.etag,
			checksumSha256: this.capabilities.upload.serverChecksum ? object.checksumSha256 : undefined,
			lastModified: object.lastModified,
			metadata: { ...object.metadata },
		};
	}

	async delete(key: string): Promise<void> {
		this.trip('delete', key);
		// S3 DELETE is idempotent (a missing key still succeeds); the verify gate
		// that protects an original lives in the pipeline, not here.
		this.store.delete(key);
	}

	async list(prefix = '', opts: ListOptions = {}): Promise<ListPage> {
		this.trip('list', prefix);
		const maxKeys = opts.maxKeys ?? 1000;
		const delimiter = opts.delimiter;
		const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();

		let index = 0;
		if (opts.cursor !== undefined) {
			const found = keys.indexOf(opts.cursor);
			index = found >= 0 ? found + 1 : keys.length;
		}

		const entries: ListEntry[] = [];
		const commonPrefixes: string[] = [];
		const seenPrefixes = new Set<string>();
		let truncated = false;
		let cursor: string | null = null;

		for (; index < keys.length; index++) {
			const key = keys[index];
			if (key === undefined) {
				continue;
			}
			const groupValue = delimiter !== undefined ? groupPrefix(key, prefix, delimiter) : null;

			if (groupValue !== null) {
				if (seenPrefixes.has(groupValue)) {
					// Already represented by an emitted commonPrefix; consume without
					// spending a slot, but advance the cursor so resume continues past it.
					cursor = key;
					continue;
				}
				if (entries.length + commonPrefixes.length >= maxKeys) {
					truncated = true;
					break;
				}
				seenPrefixes.add(groupValue);
				commonPrefixes.push(groupValue);
				cursor = key;
			} else {
				if (entries.length + commonPrefixes.length >= maxKeys) {
					truncated = true;
					break;
				}
				const object = this.store.get(key);
				if (object === undefined) {
					continue;
				}
				entries.push({ key, size: object.bytes.length, etag: object.etag, lastModified: object.lastModified });
				cursor = key;
			}
		}

		return { entries, commonPrefixes, isTruncated: truncated, cursor: truncated ? cursor : null };
	}

	displayKey(key: string): string {
		// presigned-url backends browse by the literal key (spec section 3 readable
		// keys); a local-path backend would map to a filesystem path here.
		return key;
	}

	// --- test seam --------------------------------------------------------------

	async seedObject(key: string, bytes: Uint8Array, opts: SeedOptions = {}): Promise<void> {
		const copy = bytes.slice();
		this.store.set(key, {
			bytes: copy,
			etag: opts.etag ?? `"seed-${++this.etagCounter}"`,
			checksumSha256: await sha256Base64(copy),
			metadata: { ...opts.metadata },
			contentType: opts.contentType,
			lastModified: this.nextTimestamp(),
		});
	}

	objectCount(): number {
		return this.store.size;
	}

	// --- internals --------------------------------------------------------------

	private trip(op: FaultOp, key: string): void {
		const hook = this.faults[op];
		if (hook !== undefined) {
			hook(key);
		}
	}

	private require(key: string): StoredObject {
		const object = this.store.get(key);
		if (object === undefined) {
			throw new ObjectNotFoundError(key);
		}
		return object;
	}

	private nextTimestamp(): string {
		return new Date(this.clock++ * 1000).toISOString();
	}
}

function groupPrefix(key: string, prefix: string, delimiter: string): string | null {
	const rest = key.slice(prefix.length);
	const at = rest.indexOf(delimiter);
	if (at < 0) {
		return null;
	}
	return prefix + rest.slice(0, at + delimiter.length);
}

function makeGetResult(status: number, bytes: Uint8Array, contentRange: string | undefined, checksumSha256: string): GetResult {
	return {
		status,
		contentRange,
		checksumSha256,
		stream(): ReadableStream<Uint8Array> {
			return new ReadableStream<Uint8Array>({
				start(controller): void {
					controller.enqueue(bytes.slice());
					controller.close();
				},
			});
		},
		async arrayBuffer(): Promise<ArrayBuffer> {
			const out = new Uint8Array(bytes.length);
			out.set(bytes);
			return out.buffer;
		},
	};
}

async function normalizeBody(body: PutBody): Promise<Uint8Array> {
	if (body instanceof Uint8Array) {
		return body.slice();
	}
	if (body instanceof Blob) {
		return new Uint8Array(await body.arrayBuffer());
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		if (value !== undefined) {
			chunks.push(value);
			total += value.length;
		}
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}
