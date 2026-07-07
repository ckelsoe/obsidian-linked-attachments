import type { LinkedAttachmentsSettings, LocalAttachmentSettings, OSKey } from '../../settings';

// Cross-machine resolution of the local attachment root (spec 2026-07-07). The
// pointer keeps a portable key; this module picks the right absolute root for the
// machine it runs on. It is pure (Node path/os plus a settings type, no Obsidian
// import) so every function here is unit-tested. resolveLocalRoot (env-var
// expansion + path.resolve) still runs downstream in local-backend.ts; this layer
// only chooses and joins the stored string, never expands it.

// Map process.platform to the OS key used in the per-OS roots table.
export function activeOS(platform: NodeJS.Platform = process.platform): OSKey {
	if (platform === 'win32') {
		return 'win';
	}
	if (platform === 'darwin') {
		return 'mac';
	}
	return 'linux';
}

// The root string for the current machine, still in stored (unexpanded) form.
// Reads the active OS slot from the new shape and joins the portable subpath.
// Falls back to the legacy single `localRoot` only when the new shape is absent
// entirely (an un-migrated settings object); when the new shape is present but
// this OS has no slot set, returns '' so the caller reads "no local root here"
// rather than silently borrowing another machine's path.
export function selectActiveRoot(settings: LinkedAttachmentsSettings, os: OSKey = activeOS()): string {
	const local: LocalAttachmentSettings | undefined = settings.localAttachment;
	if (local === undefined) {
		return settings.localRoot ?? '';
	}
	const root = local.roots[os];
	if (root === undefined || root.trim().length === 0) {
		return '';
	}
	return joinRootSubpath(root, local.subpath);
}

// Join a per-OS root with the portable subpath. The subpath is sanitized to a
// clean relative path first: any drive/absolute prefix, `.`/`..` traversal, and
// stray separators are dropped, so a mistyped subpath can never point the whole
// backend outside the intended sync root or, via path.resolve downstream, escape
// it. Forward slash is a safe join separator because resolveLocalRoot runs
// path.resolve, which normalizes separators per OS.
function joinRootSubpath(root: string, subpath: string): string {
	const sub = sanitizeSubpath(subpath);
	if (sub.length === 0) {
		return root;
	}
	const needsSep = !(root.endsWith('/') || root.endsWith('\\'));
	return needsSep ? `${root}/${sub}` : `${root}${sub}`;
}

// Reduce a user-entered subpath to safe, portable relative segments: split on
// either separator, drop empties, `.`, `..`, and any Windows drive-letter segment
// (`C:` / `C:foo`), then rejoin with forward slashes. Only a leading drive-letter
// colon is dropped, so a legal POSIX folder name that contains a colon elsewhere
// (`Project: Alpha`) is preserved.
function sanitizeSubpath(subpath: string): string {
	return subpath
		.trim()
		.split(/[/\\]+/)
		.filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !/^[A-Za-z]:/.test(segment))
		.join('/');
}

// Env var names whose live value, when a prefix of a picked path, makes the stored
// root portable across machines of the same OS. OneDrive first: it is the only
// cloud provider that publishes an env var, and its value is the longest/most
// specific prefix (so longest-match prefers it over USERPROFILE). This reads OS
// env-var VALUES, not hardcoded provider install paths, so it stays a generic
// string match, not a per-provider matrix.
const WINDOWS_PORTABLE_VARS = ['OneDriveCommercial', 'OneDriveConsumer', 'OneDrive', 'USERPROFILE'];
const POSIX_PORTABLE_VARS = ['HOME'];

// Rewrite a picked absolute path to its portable variable form where a known env
// var is a path-boundary prefix of it, so a Windows OneDrive pick is stored as
// `%OneDriveCommercial%\...` (survives a different drive letter) and a POSIX home
// path collapses to a leading `~` (survives a different user account). A path with
// no matching prefix is returned unchanged (the custom-folder / NAS case). The
// longest matching value wins, so the most specific (most portable) rewrite is
// chosen. env/platform are injectable for tests.
export function normalizePickedPath(
	absPath: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	const picked = absPath.trim();
	if (picked.length === 0) {
		return picked;
	}
	const win = platform === 'win32';
	const names = win ? WINDOWS_PORTABLE_VARS : POSIX_PORTABLE_VARS;
	let best: { name: string; length: number } | null = null;
	for (const name of names) {
		const value = env[name];
		if (value === undefined || value.length === 0) {
			continue;
		}
		const matchLength = boundaryPrefixLength(picked, value, win);
		if (matchLength > 0 && (best === null || matchLength > best.length)) {
			best = { name, length: matchLength };
		}
	}
	if (best === null) {
		return picked;
	}
	const rest = picked.slice(best.length);
	if (win) {
		return `%${best.name}%${rest}`;
	}
	// POSIX: HOME collapses to the ~ form resolveLocalRoot expands; any other var
	// uses ${VAR}. In practice only HOME is in the POSIX list.
	return best.name === 'HOME' ? `~${rest}` : `\${${best.name}}${rest}`;
}

// If `prefix` matches the start of `path` at a path boundary (the next character
// is a separator or end of string, so C:\Users\Bob does not match C:\Users\Bobby),
// return the length in `path` consumed by the match; otherwise 0. A trailing
// separator on the prefix is ignored. Comparison is case-insensitive on Windows.
function boundaryPrefixLength(path: string, prefix: string, win: boolean): number {
	const trimmed = prefix.replace(/[/\\]+$/, '');
	if (trimmed.length === 0) {
		return 0;
	}
	const head = path.slice(0, trimmed.length);
	const matches = win ? head.toLowerCase() === trimmed.toLowerCase() : head === trimmed;
	if (!matches) {
		return 0;
	}
	const next = path.charAt(trimmed.length);
	if (next === '' || next === '/' || next === '\\') {
		return trimmed.length;
	}
	return 0;
}

// One-time migration of the legacy single `localRoot` string to the per-OS shape.
// Returns the LocalAttachmentSettings to install, or null to leave the default in
// place. Applies only when the new shape is absent from the saved data AND the
// legacy value is non-empty: that value becomes this machine's slot under provider
// 'custom' with an empty subpath (the raw value is preserved so it resolves
// exactly as it did before). A blank legacy value stays blank; a data.json that
// already has the new shape is untouched.
export function migratedLocalAttachment(
	existing: LocalAttachmentSettings | undefined,
	legacyLocalRoot: string | undefined,
	os: OSKey = activeOS(),
): LocalAttachmentSettings | null {
	if (existing !== undefined) {
		return null;
	}
	if (legacyLocalRoot === undefined || legacyLocalRoot.trim().length === 0) {
		return null;
	}
	return { provider: 'custom', subpath: '', roots: { [os]: legacyLocalRoot } };
}
