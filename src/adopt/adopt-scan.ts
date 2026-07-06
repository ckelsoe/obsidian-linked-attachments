import { extractExtension, LA_VERSION, PointerRecord } from '../pointer/codec';
import { ListEntry, StorageBackend } from '../storage/backend';
import { OBJECT_METADATA_KEYS } from '../manifest/manifest';

// Adopt-from-bucket (spec section 4 Link bullet, section 7.9). Create pointers
// for objects already in the bucket. The moat-critical scope wall: bulk adopt may
// only LIST-under-a-prefix and CREATE pointers - NO head/get, no browse tab, no
// search, no preview, no mutation. The lock test (300 keys -> 300 pointers, zero
// head/get) enforces it. Because the scan is LIST-only it cannot read object
// metadata, so every bulk-adopted pointer is honestly ASSERTED with hash null and
// keyKind external. The paste-a-key path is the one exception: a single HEAD that
// may read our claimed hash. Adoption NEVER yields a verified tier (spec section
// 4) - VERIFIED always requires bytes through sha256.

export type AdoptRowStatus = 'adoptable' | 'already-adopted' | 'collision';

export interface AdoptRow {
	key: string;
	displayName: string; // the basename the user recognizes; never a raw key in the UI
	size: number;
	vaultPath: string; // mirrored conceptual file location
	pointerPath: string; // vaultPath + ".md"
	status: AdoptRowStatus;
}

export interface AdoptScanInput {
	backend: StorageBackend;
	prefix?: string;
	stripPrefix?: string;
	destinationFolder?: string;
	existingPointerKeys: Set<string>;
	existingVaultPaths: Set<string>;
	pageSize?: number;
}

export interface AdoptScanResult {
	rows: AdoptRow[];
	listCalls: number;
}

export interface AdoptOptions {
	bucket: string;
	newId: () => string;
	now: () => string;
}

export interface AdoptedPointer {
	pointerPath: string;
	record: PointerRecord;
}

export interface KeyPlacement {
	vaultPath: string;
}

export type AdoptByKeyResult = AdoptedPointer | { collision: true };

export async function scanForAdoption(input: AdoptScanInput): Promise<AdoptScanResult> {
	const prefix = input.prefix ?? '';
	const pageSize = input.pageSize;
	const entries: ListEntry[] = [];
	let listCalls = 0;
	let cursor: string | null = null;

	// Paginate LIST only. No head/get is ever issued.
	do {
		const page = await input.backend.list(prefix, { maxKeys: pageSize, cursor: cursor ?? undefined });
		listCalls++;
		entries.push(...page.entries);
		cursor = page.cursor;
	} while (cursor !== null);

	const rows = entries.map((entry) => classify(entry, input));
	return { rows, listCalls };
}

export function buildAdoptedPointer(row: AdoptRow, options: AdoptOptions): AdoptedPointer {
	return {
		pointerPath: row.pointerPath,
		record: assertedRecord({
			key: row.key,
			byteSize: row.size,
			vaultPath: row.vaultPath,
			bucket: options.bucket,
			id: options.newId(),
			now: options.now(),
			hash: null,
			keyKind: 'external',
		}),
	};
}

// Paste-a-key: a single HEAD (no LIST) to size the object and read our claimed
// hash from metadata if present. Still ASSERTED - found, not verified.
export async function adoptByKey(
	backend: StorageBackend,
	key: string,
	placement: KeyPlacement,
	options: AdoptOptions,
): Promise<AdoptByKeyResult> {
	const head = await backend.head(key);
	const claimedHash = head.metadata?.[OBJECT_METADATA_KEYS.sha256] ?? null;
	return {
		pointerPath: `${placement.vaultPath}.md`,
		record: assertedRecord({
			key,
			byteSize: head.size,
			vaultPath: placement.vaultPath,
			bucket: options.bucket,
			id: options.newId(),
			now: options.now(),
			hash: claimedHash,
			// Our metadata present -> a hash key we (or our format) placed; otherwise foreign.
			keyKind: claimedHash !== null ? 'hash' : 'external',
		}),
	};
}

// --- internals --------------------------------------------------------------

// Mirror a bucket key to a vault path: strip an optional source prefix and place
// the remainder under an optional destination folder. Shared with the
// reconciliation scanner's "link it" action so both mirror identically.
export function mirrorKeyToVaultPath(key: string, opts: { stripPrefix?: string; destinationFolder?: string }): string {
	const remainder = stripLeadingSlash(stripPrefix(key, opts.stripPrefix));
	if (opts.destinationFolder !== undefined && opts.destinationFolder.length > 0) {
		return `${trimSlashes(opts.destinationFolder)}/${remainder}`;
	}
	return remainder;
}

function classify(entry: ListEntry, input: AdoptScanInput): AdoptRow {
	const vaultPath = mirrorKeyToVaultPath(entry.key, { stripPrefix: input.stripPrefix, destinationFolder: input.destinationFolder });
	const remainder = stripLeadingSlash(stripPrefix(entry.key, input.stripPrefix));
	const pointerPath = `${vaultPath}.md`;

	let status: AdoptRowStatus = 'adoptable';
	// already-adopted takes precedence over collision: a key that has a pointer is
	// simply hidden, regardless of any path collision.
	if (input.existingPointerKeys.has(entry.key)) {
		status = 'already-adopted';
	} else if (input.existingVaultPaths.has(pointerPath) || input.existingVaultPaths.has(vaultPath)) {
		status = 'collision';
	}

	return { key: entry.key, displayName: basename(remainder), size: entry.size, vaultPath, pointerPath, status };
}

interface AssertedInput {
	key: string;
	byteSize: number;
	vaultPath: string;
	bucket: string;
	id: string;
	now: string;
	hash: string | null;
	keyKind: 'hash' | 'external';
}

function assertedRecord(input: AssertedInput): PointerRecord {
	const name = basename(input.vaultPath);
	return {
		laVersion: LA_VERSION,
		id: input.id,
		hash: input.hash,
		backends: [{ type: 's3', bucket: input.bucket, key: input.key, keyKind: input.keyKind }],
		originalName: name,
		originalExt: extractExtension(name),
		originalPath: input.vaultPath,
		byteSize: input.byteSize,
		contentType: '', // unknown without a body / HEAD content-type read
		copyState: 'offloaded',
		verificationTier: 'asserted',
		remoteChecksum: null,
		checksumAlgo: null,
		partSize: null,
		partCount: null,
		offloadedAt: input.now,
		sourceVersion: null,
		supersedes: null,
	};
}

function stripPrefix(key: string, prefix: string | undefined): string {
	if (prefix !== undefined && prefix.length > 0 && key.startsWith(prefix)) {
		return key.slice(prefix.length);
	}
	return key;
}

function stripLeadingSlash(value: string): string {
	return value.startsWith('/') ? value.slice(1) : value;
}

function trimSlashes(value: string): string {
	return value.replace(/^\/+|\/+$/g, '');
}

function basename(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? path.slice(slash + 1) : path;
}
