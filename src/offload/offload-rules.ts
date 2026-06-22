// Per-extension offload rule policy. A pure decision layer that is the SINGLE
// source of truth for "should this file be offloaded by type". Both consumers read
// it: the forward auto-offload trigger (on vault create) and the retroactive vault
// sweep. Keeping one policy means a file caught going forward is exactly a file the
// sweep would catch, and vice versa.
//
// Each rule is keyed by extension and is one of two modes:
//   - 'always'    : offload this type at any size (e.g. epub - never want it local);
//   - 'over-size' : offload only at or over the rule's OWN MB threshold (e.g. pdf
//                   over 5 MB, mp4 over 100 MB - small ones sync fine, big ones do not).
// A type with no rule is never offloaded (absence == never). This replaces the older
// single comma allowlist + one global threshold, which could not say "always" and
// could not vary the threshold by type.

const BYTES_PER_MB = 1024 * 1024;

export type OffloadRuleMode = 'always' | 'over-size';

export interface OffloadRule {
	extension: string; // normalized: lowercase, no leading dot
	mode: OffloadRuleMode;
	thresholdMb: number; // consulted only when mode === 'over-size'
	// A disabled rule stays configured but offloads nothing - useful for staging a
	// rule before turning it on, or pausing one while testing. Optional for
	// back-compat: a rule with no enabled field is treated as enabled.
	enabled?: boolean;
}

export interface RuleCandidate {
	extension: string;
	size: number; // bytes
}

export type RuleDecision =
	| { offload: false; reason: string }
	| { offload: true; matched: OffloadRule };

// Decide whether a file's type + size means it should be offloaded, given the rule
// table. The first rule matching the (case-insensitive) extension wins;
// normalizeRules guarantees one rule per type, so "first" is unambiguous.
export function decideByRules(candidate: RuleCandidate, rules: OffloadRule[]): RuleDecision {
	const ext = normalizeExtension(candidate.extension);
	const matched = rules.find((r) => normalizeExtension(r.extension) === ext);
	if (matched === undefined) {
		return { offload: false, reason: `no offload rule is listed for .${ext} files` };
	}
	if (matched.enabled === false) {
		return { offload: false, reason: `the offload rule for .${ext} files is turned off` };
	}
	if (matched.mode === 'always') {
		return { offload: true, matched };
	}
	// over-size: inclusive threshold (>=), matching the existing auto-offload boundary.
	const thresholdBytes = Math.max(0, matched.thresholdMb) * BYTES_PER_MB;
	if (candidate.size < thresholdBytes) {
		return { offload: false, reason: `below the ${matched.thresholdMb} MB threshold for .${ext} files` };
	}
	return { offload: true, matched };
}

// Lowercase, strip a leading dot, trim. The settings UI and the legacy allowlist
// both feed user-typed extensions, so every comparison goes through this.
export function normalizeExtension(raw: string): string {
	return raw.trim().replace(/^\.+/, '').toLowerCase();
}

// Clean a raw rule table for persistence and matching: normalize each extension,
// drop rules whose extension is blank, clamp a negative threshold to 0, and keep
// the FIRST rule for any duplicated type so a stray second row never silently
// shadows the intended one.
export function normalizeRules(rules: OffloadRule[]): OffloadRule[] {
	const seen = new Set<string>();
	const out: OffloadRule[] = [];
	for (const rule of rules) {
		const extension = normalizeExtension(rule.extension);
		if (extension.length === 0 || seen.has(extension)) {
			continue;
		}
		seen.add(extension);
		// Persist enabled explicitly (undefined -> true) so stored data is unambiguous.
		out.push({ extension, mode: rule.mode, thresholdMb: Math.max(0, rule.thresholdMb), enabled: rule.enabled !== false });
	}
	return out;
}

// Migrate the pre-2.1 settings (one comma-separated allowlist + one global MB
// threshold) into the rule table: each allowlisted type becomes an 'over-size' rule
// carrying the old global threshold, so an upgrade does not change what already
// qualified. Types the user wants offloaded regardless of size are then a one-click
// switch to 'always' in the new UI.
export function rulesFromLegacy(allowlistText: string, globalThresholdMb: number): OffloadRule[] {
	const rules = allowlistText
		.split(',')
		.map((entry) => normalizeExtension(entry))
		.filter((entry) => entry.length > 0)
		.map((extension): OffloadRule => ({ extension, mode: 'over-size', thresholdMb: Math.max(0, globalThresholdMb), enabled: true }));
	return normalizeRules(rules);
}
