import { promises as fs } from 'fs';
import * as nodePath from 'path';
import * as os from 'os';
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
import { bodyToBytes, bytesToStream, toArrayBuffer } from './body';

// The local-filesystem StorageBackend (spec section 3 archetype C): the same
// offload / verify / reconcile engine, pointed at a folder outside the vault
// (a OneDrive / Dropbox / iCloud sync folder, a NAS mount, any local path)
// instead of an S3 bucket. It is the access-axis proof - the seam was written so
// a backend could satisfy every primitive WITHOUT S3 vocabulary, and this is the
// backend that cashes that in.
//
// Desktop-only: it uses Node `fs`, so the plugin manifest sets
// `isDesktopOnly: true` (Obsidian's submission rule: a plugin that touches the
// Node/Electron API must declare desktop-only). The whole plugin therefore never
// loads on mobile, so the static `fs` import is safe and no per-call platform
// guard is needed.
//
// Capability shape vs S3 (spec section 3, two axes):
//   - upload.presign / serverChecksum / conditionalWrite = false: a folder has
//     no presigned URL, no server-side checksum validation, no If-Match. So the
//     F1 verify ladder (verify.ts) skips rungs 1-2 and lands on rung 3
//     (GET + rehash), which for a local file is a cheap read-back-and-hash and
//     yields an honest `content` tier - no weaker claim than S3.
//   - upload.range = true: a file trivially honours a byte range.
//   - access = 'local-path': the object is reached by opening a filesystem path
//     in the OS file explorer / default app, never a download. `displayKey`
//     returns that path.
//
// `etag` is mtime+size (the interface treats etag as an opaque change-detection
// token, never identity - spec section 3); identity stays the content sha256 the
// pointer records. No object metadata: a plain file carries none, so the
// disaster-recovery spine lives in the pointer note, not the bytes.

const CAPABILITIES: Capabilities = {
	upload: { presign: false, range: true, serverChecksum: false, conditionalWrite: false },
	access: 'local-path',
};

// Windows MAX_PATH: a normal (non-`\\?\`) path is limited to 260 characters
// including the terminator, so 260+ fails unless long-path support is enabled.
const WINDOWS_MAX_PATH = 260;

interface WalkedObject {
	size: number;
	etag: string;
	lastModified: string;
}

export class LocalBackend implements StorageBackend {
	readonly capabilities: Capabilities = CAPABILITIES;

	// `root` is an already-resolved absolute path (env-var expansion happens in the
	// factory, not here, so this class stays a pure filesystem mapper).
	constructor(private readonly root: string) {}

	async put(key: string, body: PutBody, size: number, opts: PutOptions = {}): Promise<PutResult> {
		const bytes = await bodyToBytes(body);
		if (size !== bytes.length) {
			// A declared size that disagrees with the body is a truncated or
			// over-declared upload; reject it rather than persist a wrong-length file
			// (mirrors MemoryBackend / the S3 size contract).
			throw new BackendError('network', `declared size ${size} != body length ${bytes.length} for ${key}`);
		}
		const filePath = this.keyToPath(key);
		await fs.mkdir(nodePath.dirname(filePath), { recursive: true });
		await this.writeAtomic(filePath, bytes);
		const stat = await fs.stat(filePath);
		// No serverChecksum: return no checksum, exactly as the interface says an
		// unvalidating backend must (the verify ladder then uses GET+rehash). The
		// `opts.checksumSha256` a caller passes is simply not honoured server-side.
		void opts;
		return { etag: statEtag(stat.size, stat.mtimeMs) };
	}

	async get(key: string, range?: GetRange): Promise<GetResult> {
		const filePath = this.keyToPath(key);
		if (range !== undefined) {
			return this.getRange(filePath, key, range);
		}
		const bytes = await this.readWhole(filePath, key);
		return makeGetResult(200, bytes, undefined);
	}

	async head(key: string): Promise<HeadResult> {
		const stat = await this.statOrNotFound(key);
		return {
			size: stat.size,
			etag: statEtag(stat.size, stat.mtimeMs),
			lastModified: new Date(stat.mtimeMs).toISOString(),
			// A plain file has no object metadata; the pointer note carries the
			// disaster-recovery spine instead.
			metadata: {},
		};
	}

	async delete(key: string): Promise<void> {
		const filePath = this.keyToPath(key);
		try {
			await fs.unlink(filePath);
		} catch (error) {
			// Idempotent like S3 DELETE: a missing file is already "gone". The verify
			// gate that protects an original lives in the pipeline, not here.
			if (isErrnoCode(error, 'ENOENT')) {
				return;
			}
			// A key that maps to a directory (a prefix folder) is not an object;
			// unlink reports EISDIR (POSIX) or EPERM (Windows). Swallow it only after
			// confirming it really is a directory, so a genuine EPERM on a locked or
			// read-only file still surfaces.
			if ((isErrnoCode(error, 'EISDIR') || isErrnoCode(error, 'EPERM')) && (await isDirectory(filePath))) {
				return;
			}
			throw error;
		}
		// Leave no empty skeleton behind under "preserve structure": prune now-empty
		// parent directories up to (never including) the root.
		await this.pruneEmptyParents(nodePath.dirname(filePath));
	}

	async list(prefix = '', opts: ListOptions = {}): Promise<ListPage> {
		const objects = await this.walk(prefix);
		return pageObjects(objects, prefix, opts);
	}

	displayKey(key: string): string {
		// The access-axis payoff: a local backend reaches an object by opening this
		// filesystem path, not by downloading a presigned URL (spec section 3).
		return this.keyToPath(key);
	}

	// --- internals --------------------------------------------------------------

	// Map a forward-slash key to an absolute filesystem path under the root, using
	// the OS separator at resolve time (spec: store forward slashes, convert to
	// path.sep here so pointers are portable between Windows and macOS). Reject any
	// key that would escape the root - a defensive guard against a traversal
	// sequence in a key the plugin did not mint.
	private keyToPath(key: string): string {
		if (key.includes('\\')) {
			// Keys are always forward-slash (the codec stores them that way). A
			// backslash would alias with the forward-slash form on Windows (a\b vs
			// a/b resolve to the same file) and could smuggle a `..\` traversal past
			// the segment check below, so reject it outright.
			throw new BackendError('network', `invalid key (backslash separator): ${key}`);
		}
		const segments = key.split('/');
		if (segments.some((segment) => segment === '..' || segment === '.' || segment.length === 0)) {
			throw new BackendError('network', `invalid key (empty or traversal segment): ${key}`);
		}
		const resolved = nodePath.resolve(this.root, ...segments);
		const rootWithSep = this.root.endsWith(nodePath.sep) ? this.root : this.root + nodePath.sep;
		if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
			throw new BackendError('network', `key resolves outside the local root: ${key}`);
		}
		// Windows caps a normal path at 260 chars (MAX_PATH). Refuse a too-long path up
		// front with an actionable message instead of letting the fs call fail with a
		// cryptic ENOENT/ENAMETOOLONG mid-offload; the offload then rolls back and the
		// vault original is kept (no data loss). A shorter local root or vault path, or
		// enabling long-path support, resolves it.
		if (process.platform === 'win32' && resolved.length >= WINDOWS_MAX_PATH) {
			throw new BackendError('network', `local path exceeds the Windows ${WINDOWS_MAX_PATH}-character limit (${resolved.length} chars); shorten the local root or the vault path: ${resolved}`);
		}
		return resolved;
	}

	// Write to a sibling temp file, fsync it, then rename over the target, so a
	// crash mid-write never leaves a partially written object at the real key
	// (rename is atomic on the same filesystem) and the bytes are durable before
	// the offload pipeline is told the copy exists. This is the local backend's
	// half of verify-before-delete: without the fsync a power loss after put()
	// returns could lose the offloaded copy while the vault original is already
	// gone. The temp name carries a random UUID so two processes writing the same
	// key against one synced folder (two devices) never collide on the temp file.
	private async writeAtomic(filePath: string, bytes: Uint8Array): Promise<void> {
		const tmpPath = `${filePath}.la-tmp-${crypto.randomUUID()}`;
		try {
			const handle = await fs.open(tmpPath, 'w');
			try {
				// writeFile writes the WHOLE buffer (looping over any short writes);
				// a bare handle.write() may persist a truncated file on a short write.
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(tmpPath, filePath);
		} catch (error) {
			await fs.rm(tmpPath, { force: true });
			throw error;
		}
		await fsyncDir(nodePath.dirname(filePath));
	}

	private async readWhole(filePath: string, key: string): Promise<Uint8Array> {
		// statOrNotFound also rejects a directory key (a prefix folder is not an
		// object), so a full GET of "a" when only "a/b" exists is a clean
		// ObjectNotFoundError, not a raw EISDIR.
		await this.statOrNotFound(key);
		const buffer = await fs.readFile(filePath);
		return new Uint8Array(buffer);
	}

	private async getRange(filePath: string, key: string, range: GetRange): Promise<GetResult> {
		const stat = await this.statOrNotFound(key);
		// HTTP Range semantics: end is inclusive. Clamp both ends into [0, size-1]
		// so an out-of-range or reversed request yields an empty, well-formed 206
		// (`bytes start-start/size`) rather than a malformed `bytes 0--1/0`.
		const size = stat.size;
		const start = Math.min(Math.max(0, range.start), size);
		const endInclusive = Math.min(range.end, size - 1);
		const requested = endInclusive >= start ? endInclusive - start + 1 : 0;
		let bytes = new Uint8Array(0);
		if (requested > 0) {
			const buffer = Buffer.alloc(requested);
			const handle = await fs.open(filePath, 'r');
			try {
				// Honour the actual bytesRead: if the file was truncated after the
				// stat, return only what was read, never a zero-padded buffer.
				const { bytesRead } = await handle.read(buffer, 0, requested, start);
				bytes = new Uint8Array(buffer.subarray(0, bytesRead));
			} finally {
				await handle.close();
			}
		}
		const lastByte = bytes.length > 0 ? start + bytes.length - 1 : start;
		return makeGetResult(206, bytes, `bytes ${start}-${lastByte}/${size}`);
	}

	private async statOrNotFound(key: string): Promise<{ size: number; mtimeMs: number }> {
		const filePath = this.keyToPath(key);
		let stat;
		try {
			stat = await fs.stat(filePath);
		} catch (error) {
			throw this.notFoundOrRethrow(error, key);
		}
		if (!stat.isFile()) {
			// A directory (or other non-file) at the key is not an object; report it
			// as not-found so head/get behave like S3, which has no directories.
			throw new ObjectNotFoundError(key);
		}
		return { size: stat.size, mtimeMs: stat.mtimeMs };
	}

	private notFoundOrRethrow(error: unknown, key: string): unknown {
		if (isErrnoCode(error, 'ENOENT')) {
			return new ObjectNotFoundError(key);
		}
		return error;
	}

	private async pruneEmptyParents(dir: string): Promise<void> {
		let current = dir;
		const rootResolved = nodePath.resolve(this.root);
		while (current.startsWith(rootResolved) && current !== rootResolved) {
			try {
				await fs.rmdir(current);
			} catch {
				// Not empty (or already gone): stop climbing; a non-empty ancestor is
				// the normal case and never an error.
				return;
			}
			current = nodePath.dirname(current);
		}
	}

	// Gather every file under the smallest directory that could contain the prefix,
	// as forward-slash keys relative to the root, with size + etag + mtime. Bounding
	// the walk to the prefix's directory ancestor keeps a paginated LIST loop from
	// re-walking the whole tree per page.
	private async walk(prefix: string): Promise<Map<string, WalkedObject>> {
		const slash = prefix.lastIndexOf('/');
		const dirPrefix = slash >= 0 ? prefix.slice(0, slash) : '';
		const startDir = dirPrefix.length > 0 ? this.keyToPath(dirPrefix) : nodePath.resolve(this.root);
		const out = new Map<string, WalkedObject>();
		await this.walkDir(startDir, out);
		return out;
	}

	private async walkDir(dir: string, out: Map<string, WalkedObject>): Promise<void> {
		let dirents;
		try {
			dirents = await fs.readdir(dir, { withFileTypes: true });
		} catch (error) {
			// A missing start directory just means "no objects under this prefix".
			if (isErrnoCode(error, 'ENOENT')) {
				return;
			}
			throw error;
		}
		for (const dirent of dirents) {
			const full = nodePath.join(dir, dirent.name);
			if (dirent.isDirectory()) {
				await this.walkDir(full, out);
			} else if (dirent.isFile()) {
				if (dirent.name.includes('.la-tmp-')) {
					// An interrupted writeAtomic temp file is not an object; never list it.
					continue;
				}
				const stat = await fs.stat(full);
				const relative = nodePath.relative(nodePath.resolve(this.root), full);
				const key = relative.split(nodePath.sep).join('/');
				out.set(key, { size: stat.size, etag: statEtag(stat.size, stat.mtimeMs), lastModified: new Date(stat.mtimeMs).toISOString() });
			}
		}
	}
}

// Expand environment variables in a user-entered root and resolve it to an
// absolute path, so one pointer resolves the same folder on machines with different
// user profiles (spec: %OneDriveCommercial%, $HOME). Supports %VAR% (Windows),
// $VAR / ${VAR} (POSIX), and a leading ~ for the home dir. Returns '' for a
// blank input, which the caller reads as "no local root configured".
export function resolveLocalRoot(raw: string): string {
	// Strip surrounding quotes (a common paste artifact from Explorer's "Copy as
	// path"): the path goes straight to fs, never a shell, so a literal quote would
	// become part of the path and fail. A bare path with spaces needs no quoting.
	const trimmed = stripSurroundingQuotes(raw.trim());
	if (trimmed.length === 0) {
		return '';
	}
	return nodePath.resolve(expandEnv(trimmed));
}

function stripSurroundingQuotes(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}

function expandEnv(input: string): string {
	let out = input.replace(/%([^%]+)%/g, (whole: string, name: string) => process.env[name] ?? whole);
	out = out.replace(/\$\{([^}]+)\}/g, (whole: string, name: string) => process.env[name] ?? whole);
	out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole: string, name: string) => process.env[name] ?? whole);
	if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
		out = os.homedir() + out.slice(1);
	}
	return out;
}

// Best-effort fsync of a directory so a freshly created/renamed entry is durable,
// not just its contents. Some platforms (notably Windows) refuse to open a
// directory for fsync; that is not an error, so swallow it - the file's own sync
// in writeAtomic is the load-bearing durability step.
async function fsyncDir(dir: string): Promise<void> {
	let handle;
	try {
		handle = await fs.open(dir, 'r');
	} catch {
		return;
	}
	try {
		await handle.sync();
	} catch {
		// Directory fsync unsupported on this platform; ignore.
	} finally {
		await handle.close();
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await fs.lstat(path)).isDirectory();
	} catch {
		return false;
	}
}

function statEtag(size: number, mtimeMs: number): string {
	// Opaque change-detection token (spec section 3): a file's size + mtime changes
	// whenever its bytes do, which is all etag is ever used for. Quoted to match the
	// S3 etag shape callers already normalize.
	return `"${size}-${Math.round(mtimeMs)}"`;
}

function isErrnoCode(error: unknown, code: string): boolean {
	// Duck-type the errno `code` rather than `instanceof Error`: a Node fs rejection
	// can cross a module/realm boundary (jest, bundlers) where instanceof silently
	// fails, and the errno code is the only thing actually being asserted.
	return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function makeGetResult(status: number, bytes: Uint8Array, contentRange: string | undefined): GetResult {
	return {
		status,
		contentRange,
		// No server checksum on a local file; the ladder rehashes the bytes itself.
		checksumSha256: undefined,
		stream(): ReadableStream<Uint8Array> {
			return bytesToStream(bytes);
		},
		arrayBuffer(): Promise<ArrayBuffer> {
			return Promise.resolve(toArrayBuffer(bytes));
		},
	};
}

// Prefix + delimiter + cursor + maxKeys paging over a gathered key set, identical
// in shape to MemoryBackend's list so reconcile and the tests see one behavior
// across backends (the "second copy is the moment to parameterize" rule; kept a
// copy here rather than exported to avoid coupling the in-memory test double to
// the production filesystem module).
function pageObjects(objects: Map<string, WalkedObject>, prefix: string, opts: ListOptions): ListPage {
	// A non-positive maxKeys would make the loop truncate before emitting anything
	// (isTruncated:true, cursor:null), which a "loop until cursor === null" caller
	// reads as "done" while it silently got nothing. Clamp to the S3 default.
	const maxKeys = opts.maxKeys !== undefined && opts.maxKeys > 0 ? opts.maxKeys : 1000;
	const delimiter = opts.delimiter;
	const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();

	let index = 0;
	if (opts.cursor !== undefined) {
		// Resume at the first key strictly greater than the cursor. Using the first
		// greater key (not indexOf) keeps pagination correct even if the cursor key
		// was deleted between pages - a real case for a mutable local folder.
		const cursor = opts.cursor;
		const next = keys.findIndex((k) => k > cursor);
		index = next >= 0 ? next : keys.length;
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
			const object = objects.get(key);
			if (object === undefined) {
				continue;
			}
			entries.push({ key, size: object.size, etag: object.etag, lastModified: object.lastModified });
			cursor = key;
		}
	}

	return { entries, commonPrefixes, isTruncated: truncated, cursor: truncated ? cursor : null };
}

function groupPrefix(key: string, prefix: string, delimiter: string): string | null {
	const rest = key.slice(prefix.length);
	const at = rest.indexOf(delimiter);
	if (at < 0) {
		return null;
	}
	return prefix + rest.slice(0, at + delimiter.length);
}
