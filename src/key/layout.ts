import { extractExtension, KeyKind, PointerRecord } from '../pointer/codec';

// The key-layout function (spec section 3). A plugin-placed object's key mirrors
// the vault path for browsability and carries a short content-hash suffix:
//
//   <vaultPrefix>/<mirrored dir>/<stem>--<shortHash><.ext>
//   charles-main/31-books/Romans/Cranfield--9f86d0.pdf
//
// The key is assigned ONCE at offload and is immutable thereafter: it is a
// birth-time label, decoupled from the vault path. A vault rename updates only
// the pointer's path fields, never the key (rename never triggers an S3 copy).
// The full sha256 in frontmatter is the permanent identity; the short-hash
// suffix gives collision-safety and overwrite self-detection at vault scale.

export interface KeyInput {
	vaultPrefix: string;
	originalPath: string;
	hash: string; // full sha256 hex; the identity the short suffix is taken from
	hashLength?: number; // short-hash length, default 6 hex chars
}

export interface KeyAssignment {
	key: string;
	keyKind: KeyKind;
}

export interface SupersedingKeyAssignment extends KeyAssignment {
	supersedes: string;
}

const DEFAULT_SHORT_HASH_LENGTH = 6;

export function layoutHashKey(input: KeyInput): KeyAssignment {
	const shortHash = input.hash.slice(0, input.hashLength ?? DEFAULT_SHORT_HASH_LENGTH);
	const { dir, name } = splitPath(input.originalPath);
	const ext = extractExtension(name);
	const stem = ext.length > 0 ? name.slice(0, name.length - ext.length - 1) : name;

	const segments = [
		...splitSegments(input.vaultPrefix),
		...splitSegments(dir),
		`${sanitizeSegment(stem)}--${shortHash}${ext.length > 0 ? `.${sanitizeSegment(ext)}` : ''}`,
	];
	return { key: segments.join('/'), keyKind: 'hash' };
}

// Adopt a foreign object's key verbatim: the plugin did not place it, so the key
// is whatever the external writer chose, and the keyKind records that.
export function adoptExternalKey(rawKey: string): KeyAssignment {
	return { key: rawKey, keyKind: 'external' };
}

// Re-upload of different bytes at the same path: a NEW content-addressed key,
// with the prior key retained in the supersedes chain (additive, never an
// overwrite; spec section 10).
export function supersedingKey(input: KeyInput, supersedesKey: string): SupersedingKeyAssignment {
	const assignment = layoutHashKey(input);
	return { ...assignment, supersedes: supersedesKey };
}

// A vault rename / move: metadata-only. Updates the pointer's path, name, and
// ext; leaves the key, hash, bucket, and id untouched.
export function applyVaultRename(record: PointerRecord, newOriginalPath: string): PointerRecord {
	const { name } = splitPath(newOriginalPath);
	return {
		...record,
		originalPath: newOriginalPath,
		originalName: name,
		originalExt: extractExtension(name),
	};
}

// --- internals --------------------------------------------------------------

function splitPath(path: string): { dir: string; name: string } {
	const slash = path.lastIndexOf('/');
	if (slash < 0) {
		return { dir: '', name: path };
	}
	return { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

function splitSegments(path: string): string[] {
	return path
		.split('/')
		.filter((segment) => segment.length > 0)
		.map(sanitizeSegment);
}

// Make a path segment safe and deterministic for a browsable key. Control
// characters and backslashes are replaced; internal whitespace is collapsed;
// leading/trailing whitespace and trailing dots are trimmed (awkward in many S3
// tools). Unicode letters and spaces are preserved for readability. A segment
// that sanitizes to empty becomes "_" so the path structure never collapses.
function sanitizeSegment(segment: string): string {
	let safe = '';
	for (const ch of segment) {
		const code = ch.charCodeAt(0);
		if (code < 0x20 || code === 0x7f || ch === '\\') {
			safe += ' ';
		} else {
			safe += ch;
		}
	}
	safe = safe.replace(/\s+/g, ' ').trim().replace(/\.+$/, '').trim();
	return safe.length > 0 ? safe : '_';
}
