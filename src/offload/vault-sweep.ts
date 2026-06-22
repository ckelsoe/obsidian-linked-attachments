// The retroactive vault sweep planner. Pure: given the vault's attachment files and
// the shared per-extension rule table, it decides which files the sweep would
// offload and groups them by type for the dry-run preview. It reuses the SAME
// decideByRules policy as the forward auto-offload trigger, so "scan my vault now"
// catches exactly the files that would be caught going forward - never a different
// set. The structural guards (never markdown, never a checked-out working copy)
// match the trigger's guards. The actual enumeration (app.vault.getFiles) and the
// batch upload are the Obsidian-coupled layer; this module is selection + grouping.

import { OffloadRule, decideByRules, normalizeExtension } from './offload-rules';
import { CHECKOUT_DIR_PREFIX } from './auto-offload';

export interface SweepFile {
	path: string;
	extension: string;
	size: number; // bytes
}

export interface SweepGroup {
	extension: string; // normalized
	count: number;
	totalBytes: number;
}

export interface SweepPlan {
	selected: SweepFile[]; // files the rules qualify, in input order
	groups: SweepGroup[]; // selected files grouped by type, largest total first
	totalBytes: number; // sum over the selection
	skipped: number; // files considered but not selected
}

// Plan the sweep over a list of candidate files. Markdown and checked-out working
// copies are never selected regardless of the rules; everything else is decided by
// decideByRules.
export function planVaultSweep(files: SweepFile[], rules: OffloadRule[]): SweepPlan {
	const selected: SweepFile[] = [];
	for (const file of files) {
		if (!isSweepable(file)) {
			continue;
		}
		if (decideByRules({ extension: file.extension, size: file.size }, rules).offload) {
			selected.push(file);
		}
	}
	return {
		selected,
		groups: groupByExtension(selected),
		totalBytes: selected.reduce((sum, f) => sum + f.size, 0),
		skipped: files.length - selected.length,
	};
}

// A file is eligible for the sweep only if it is an attachment that lives outside
// the plugin's working dir. Markdown (ordinary notes AND pointer notes) is excluded
// outright - the heavy-bytes invariant only concerns binary attachments, and
// sweeping notes would be catastrophic. A checked-out working copy is the plugin's
// own transient editable copy and returns to the bucket only via check-in.
function isSweepable(file: SweepFile): boolean {
	if (normalizeExtension(file.extension) === 'md') {
		return false;
	}
	if (file.path.startsWith(CHECKOUT_DIR_PREFIX)) {
		return false;
	}
	return true;
}

function groupByExtension(files: SweepFile[]): SweepGroup[] {
	const byExt = new Map<string, SweepGroup>();
	for (const file of files) {
		const extension = normalizeExtension(file.extension);
		const group = byExt.get(extension) ?? { extension, count: 0, totalBytes: 0 };
		group.count += 1;
		group.totalBytes += file.size;
		byExt.set(extension, group);
	}
	// Largest space win first; tie-break by extension for a stable, readable order.
	return [...byExt.values()].sort((a, b) => b.totalBytes - a.totalBytes || a.extension.localeCompare(b.extension));
}
