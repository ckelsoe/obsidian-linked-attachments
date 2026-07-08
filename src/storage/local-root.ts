import * as os from 'os';
import { platform as currentPlatform } from 'node:process';
import type { LinkedAttachmentsSettings, LocalAttachmentSettings, LocalMachineRoot } from '../../settings';

// The Node platform union, defined locally rather than via the `NodeJS.Platform`
// global so the plugin does not depend on that ambient type being present.
type NodePlatform = 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd';

// Cross-machine resolution of the local attachment root (2026-07-07). The pointer
// keeps a portable key; this module picks the right absolute folder for the machine
// it runs on by matching the machine's hostname against a stored per-machine list.
// It is pure (Node os plus a settings type, no Obsidian import) so every function
// here is unit-tested. resolveLocalRoot (in local-backend.ts) still runs downstream
// to turn the stored path into an absolute one and fail closed on a bad value.

// This machine's identity: its hostname, trimmed. Used both as the match key when
// resolving and as the pre-filled name when the user adds this machine in settings.
export function activeMachine(hostname: string = os.hostname()): string {
	return hostname.trim();
}

// The stored root for the current machine, or '' when this machine has no entry.
// Matches by hostname against the per-machine list; falls back to the legacy single
// `localRoot` only when the new shape is absent entirely (an un-migrated settings
// object).
export function selectActiveRoot(settings: LinkedAttachmentsSettings, machine: string = activeMachine()): string {
	const local: LocalAttachmentSettings | undefined = settings.localAttachment;
	if (local === undefined || !Array.isArray(local.machines)) {
		return settings.localRoot ?? '';
	}
	const key = machine.trim();
	if (key.length === 0) {
		// No usable hostname to match on; treat as unconfigured rather than matching a
		// stray empty-named row (keeps this aligned with the settings UI, which refuses
		// to add or activate a row for an empty machine name).
		return '';
	}
	const entry = local.machines.find((row) => row.machine.trim() === key);
	return entry?.path ?? '';
}

// The raw persisted localAttachment can be any of three historical shapes: the
// current machine list, the unreleased per-OS `roots` shape, or absent (older
// data.json with only the legacy `localRoot`). Typed loosely for migration only.
interface RawLocalAttachment {
	machines?: unknown;
	roots?: { win?: string; mac?: string; linux?: string };
}

// One-time migration to the per-machine list. Returns the LocalAttachmentSettings
// to install, or null to leave the default in place. Handles:
//   - already the machine-list shape: nothing to do (null).
//   - the unreleased per-OS `roots` shape: carry this OS's slot into an entry for
//     this machine (so a dev vault set under the interim build is not lost).
//   - the released legacy single `localRoot`: becomes this machine's entry.
// A blank legacy value stays blank.
export function migratedLocalAttachment(
	existingRaw: RawLocalAttachment | undefined,
	legacyLocalRoot: string | undefined,
	machine: string = activeMachine(),
	platform: NodePlatform = currentPlatform,
): LocalAttachmentSettings | null {
	if (existingRaw !== undefined && Array.isArray(existingRaw.machines)) {
		return null;
	}
	if (existingRaw !== undefined && existingRaw.roots !== undefined) {
		const osKey = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
		const path = existingRaw.roots[osKey];
		// Only migrate when this OS actually has a slot. Returning an empty list here
		// would be persisted and wipe the other OSes' roots from a synced data.json
		// before those machines migrate; returning null leaves the interim shape in
		// place on disk so nothing is lost (this machine stays unconfigured until the
		// user adds it, which is correct since this OS had no folder anyway).
		return path !== undefined && path.trim().length > 0
			? { machines: [{ machine, path }] }
			: null;
	}
	if (legacyLocalRoot !== undefined && legacyLocalRoot.trim().length > 0) {
		return { machines: [{ machine, path: legacyLocalRoot }] };
	}
	return null;
}

// Whether a machine entry for this machine already exists in the list (so the
// settings UI can avoid adding a duplicate when the user clicks Add this machine).
export function hasMachineEntry(machines: LocalMachineRoot[], machine: string): boolean {
	const key = machine.trim();
	return machines.some((row) => row.machine.trim() === key);
}

// The settings UI's rendering decisions, as one pure function so they are unit
// tested rather than eyeballed: which row is the active machine, whether Add this
// machine is disabled, and the banner text + warn flag. Kept in step with
// selectActiveRoot (first hostname match wins, trimmed comparison, empty hostname
// is unmatchable). `resolvedRoot` is what resolveLocalRoot returned for this
// machine, so the banner reports the real absolute path.
export interface MachineListView {
	activeIndex: number;
	addDisabled: boolean;
	duplicateActive: boolean;
	banner: { text: string; warn: boolean };
}

export function localMachineView(machines: LocalMachineRoot[], thisMachine: string, resolvedRoot: string): MachineListView {
	const key = thisMachine.trim();
	if (key.length === 0) {
		return {
			activeIndex: -1,
			addDisabled: true,
			duplicateActive: false,
			banner: {
				text: 'Could not read this machine\'s name, so it cannot be matched automatically. Add a row and set its folder path by hand.',
				warn: true,
			},
		};
	}
	const matchIndexes: number[] = [];
	machines.forEach((row, index) => {
		if (row.machine.trim() === key) {
			matchIndexes.push(index);
		}
	});
	const matches = matchIndexes.length;
	const activeIndex = matches > 0 ? matchIndexes[0]! : -1;
	let text: string;
	let warn: boolean;
	if (matches === 0) {
		text = `This machine (${key}) is not in the list. Click Add this machine, then Browse to its offload folder.`;
		warn = true;
	} else if (resolvedRoot.length === 0) {
		text = `This machine (${key}) has no valid folder set yet. Browse to an absolute folder on this machine.`;
		warn = true;
	} else {
		text = `This machine (${key}) resolves to: ${resolvedRoot}`;
		warn = false;
	}
	if (matches > 1) {
		text += ' Warning: more than one row uses this name; only the first is used. Rename one machine so each has a unique name.';
		warn = true;
	}
	return { activeIndex, addDisabled: matches > 0, duplicateActive: matches > 1, banner: { text, warn } };
}
