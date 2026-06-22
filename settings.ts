import { S3AddressingStyle } from './credentials';
import { OffloadRule } from './src/offload/offload-rules';

// Default secret IDs. Obsidian's secret store is centralized and shared ACROSS
// plugins, keyed by name, so these carry a short "la-" prefix to reduce the chance
// of colliding with another plugin's secrets. They pre-seed the SecretComponent so
// the first run shows a meaningful, self-documenting name to create the secret
// under. The user may instead pick any existing shared secret; the component then
// reports that name through onChange and we store it. The plugin always reads by
// whatever name is in settings (getSecret(name)), so there is never a guess.
export const DEFAULT_ACCESS_KEY_SECRET_ID = 'la-access-key';
export const DEFAULT_SECRET_KEY_SECRET_ID = 'la-secret-key';

// Non-secret plugin configuration, persisted to data.json by Obsidian. The raw
// access key and secret key are NOT here; only the secretStorage IDs that
// reference them (accessKeyIdSecretName / secretAccessKeySecretName).
export interface LinkedAttachmentsSettings {
	endpoint: string;
	region: string;
	bucket: string;
	addressingStyle: S3AddressingStyle;
	accessKeyIdSecretName: string;
	secretAccessKeySecretName: string;
	// When on, debug-level app events are also written to the log. The bucket audit
	// trail, warnings, and errors are logged regardless of this setting.
	debugLogging: boolean;
	// Auto-offload on add (spec section 4b). Opt-in; off by default. When on, a
	// qualifying vault-create is offered for offload. Prompt-by-default;
	// idle-debounce is the opt-in mode. Whether a file qualifies is decided by the
	// per-extension offloadRules table below (the single policy shared with the
	// vault sweep), not a separate allowlist.
	autoOffloadEnabled: boolean;
	autoOffloadTriggerMode: 'prompt' | 'idle-debounce';
	autoOffloadIdleMinutes: number; // used only in idle-debounce mode (desktop only)
	// Per-extension offload rules: the single source of truth for which files
	// offload, by type, for both the forward trigger and the retroactive sweep.
	// Each type is 'always' (any size) or 'over-size' (at/over its own MB threshold);
	// a type with no rule is never offloaded. Replaces the pre-2.1 single allowlist +
	// global threshold (migrated forward in loadSettings).
	offloadRules: OffloadRule[];
}

export const DEFAULT_SETTINGS: LinkedAttachmentsSettings = {
	endpoint: '',
	region: '',
	bucket: '',
	// Virtual-hosted is what AWS S3 and Cloudflare R2 use; path style is for MinIO
	// and some self-hosted setups. Default to the common case.
	addressingStyle: 'virtual-hosted',
	accessKeyIdSecretName: DEFAULT_ACCESS_KEY_SECRET_ID,
	secretAccessKeySecretName: DEFAULT_SECRET_KEY_SECRET_ID,
	debugLogging: false,
	// Auto-offload defaults: off, prompt-by-default. Idle-debounce is the opt-in
	// mode; the idle window only applies when it is selected.
	autoOffloadEnabled: false,
	autoOffloadTriggerMode: 'prompt',
	autoOffloadIdleMinutes: 5,
	// Default rule table: a conservative set of arrives-complete formats, each
	// 'over-size' at a 5 MB floor (small files sync fine and are left alone) - the
	// same set and behavior as the pre-2.1 default allowlist. Switch any type to
	// 'always' in settings to offload it regardless of size.
	offloadRules: ['pdf', 'epub', 'mp3', 'm4a', 'wav', 'flac', 'zip', 'mp4', 'mov', 'png', 'jpg', 'jpeg', 'tif', 'tiff'].map(
		(extension) => ({ extension, mode: 'over-size' as const, thresholdMb: 5, enabled: true }),
	),
};
