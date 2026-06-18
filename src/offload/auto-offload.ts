// Auto-offload trigger policy (spec section 4b). A pure decision layer in front of
// the existing offload pipeline - it adds NO new offload mechanics. The invariant
// it protects: only the small pointer notes ride the user's sync; the heavy bytes
// live in the bucket. A large un-offloaded file breaks that (sync tries to push the
// raw bytes everywhere, past Sync's per-file limits). Auto-offload keeps it true
// without manual discipline. It is automation of the one-way offload, NOT mirror
// mode and NOT a silent timer by default.
//
// Deliberately conservative (mirrors section 4a's "nothing on a blind timer"):
//   - gated by type AND size (size primary, type secondary);
//   - prompt by default, never silent;
//   - opt-in idle-debounce, OFF by default;
//   - skip checked-out working copies;
//   - desktop-first: mobile may prompt but never idle-sweeps (coerced here).
//
// This module is the qualification + mode decision only. The vault-create / modify
// event wiring, the debounce timers, and the prompt UI are the Obsidian-coupled
// layer (la-p5-29). The 1.1 content-dedup pre-check runs automatically because
// auto-offload goes through the same offload pipeline.

export type AutoOffloadTriggerMode = 'prompt' | 'idle-debounce';

// The plugin's own working directory inside the vault. A checked-out editable copy
// lives at `.linked-attachments/checkout/<sha>/` (spec section 4a) and is never
// auto-offloaded - it returns to the bucket only via the explicit check-in.
export const CHECKOUT_DIR_PREFIX = '.linked-attachments/';

export interface AutoOffloadConfig {
	enabled: boolean;
	allowlist: string[]; // lowercase extensions, no leading dot
	sizeThresholdBytes: number;
	triggerMode: AutoOffloadTriggerMode;
	idleMinutes: number;
}

export interface AutoOffloadCandidate {
	path: string;
	extension: string;
	size: number;
}

export type AutoOffloadDecision =
	| { qualifies: false; reason: string }
	| { qualifies: true; mode: AutoOffloadTriggerMode };

// Decide whether a freshly-created vault file should be auto-offloaded, and in
// which mode. isDesktop coerces idle-debounce to prompt on mobile (mobile never
// runs an idle sweep - spec section 4b / section 6).
export function decideAutoOffload(
	candidate: AutoOffloadCandidate,
	config: AutoOffloadConfig,
	isDesktop: boolean,
): AutoOffloadDecision {
	if (!config.enabled) {
		return { qualifies: false, reason: 'automatic offload is turned off' };
	}
	const ext = candidate.extension.toLowerCase();
	if (ext === 'md') {
		return { qualifies: false, reason: 'markdown notes are never auto-offloaded' };
	}
	if (candidate.path.startsWith(CHECKOUT_DIR_PREFIX)) {
		return { qualifies: false, reason: 'a checked-out working copy is never auto-offloaded' };
	}
	if (!config.allowlist.map((e) => e.toLowerCase()).includes(ext)) {
		return { qualifies: false, reason: `the .${ext} type is not in the auto-offload allowlist` };
	}
	// Size is the primary signal: small files sync fine and are left alone.
	if (candidate.size < config.sizeThresholdBytes) {
		return { qualifies: false, reason: 'below the auto-offload size threshold' };
	}
	return { qualifies: true, mode: effectiveTriggerMode(config.triggerMode, isDesktop) };
}

// Idle-debounce only runs on desktop; on mobile it falls back to a prompt.
export function effectiveTriggerMode(mode: AutoOffloadTriggerMode, isDesktop: boolean): AutoOffloadTriggerMode {
	if (mode === 'idle-debounce' && !isDesktop) {
		return 'prompt';
	}
	return mode;
}

// Parse the settings allowlist string ("pdf, EPUB, .mp3") into normalized
// extensions (lowercase, no dot, no empties).
export function parseAllowlist(text: string): string[] {
	return text
		.split(',')
		.map((entry) => entry.trim().replace(/^\.+/, '').toLowerCase())
		.filter((entry) => entry.length > 0);
}
