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
// Where offloaded objects are written. `s3-only` is the historical behavior and
// the default for existing installs. `local-only` writes to a folder outside the
// vault (a synced OneDrive/Dropbox/NAS path); `local-s3` writes both, preferring
// the local copy for reads and keeping S3 as the durable off-machine backup.
export type StorageMode = 's3-only' | 'local-only' | 'local-s3';

// Which sync provider holds the local root. Phase 1 stores this as metadata and
// uses it only to tailor help text; the resolution itself is provider-agnostic
// (an env-var-normalized path per OS). Phase 2 will use it to drive auto-detect.
// 'custom' is the escape hatch: a per-machine absolute folder that covers every
// provider and NAS with no provider knowledge.
export type StorageProvider =
	| 'onedrive-business'
	| 'onedrive-personal'
	| 'dropbox'
	| 'box'
	| 'icloud'
	| 'google-drive'
	| 'custom';

// The three operating systems the plugin distinguishes for root resolution. A
// synced vault needs one root entry per OS it opens on; within an OS the env-var
// form (only OneDrive publishes one) makes the single entry portable across
// machines with different drive letters or user profiles.
export type OSKey = 'win' | 'mac' | 'linux';

// Cross-machine local root (spec 2026-07-07). Replaces the single per-vault
// `localRoot` string: that one string cannot be correct on every machine at once
// (different drive letters, Windows vs macOS). The portable per-pointer key is
// unchanged; the absolute root is resolved per machine from `roots[activeOS]`
// joined with `subpath`, then run through `resolveLocalRoot` (env-var expansion).
export interface LocalAttachmentSettings {
	provider: StorageProvider;
	// Folder inside the synced root, shared across every OS (portable). Empty for
	// a custom root that already names the full offload folder per OS.
	subpath: string;
	// Env-var-normalized root value per OS. A Windows OneDrive pick is stored as
	// `%OneDriveCommercial%\...` so it survives a different drive letter; macOS has
	// no env var, so a `~`-relative known path is used.
	roots: {
		win?: string;
		mac?: string;
		linux?: string;
	};
}

export interface LinkedAttachmentsSettings {
	endpoint: string;
	region: string;
	bucket: string;
	addressingStyle: S3AddressingStyle;
	accessKeyIdSecretName: string;
	secretAccessKeySecretName: string;
	// Storage mode plus the cross-machine local root. `localAttachment` holds the
	// per-OS roots and provider; `localRoot` is the legacy single-string form kept
	// only so an older data.json migrates forward (loadSettings maps a non-empty
	// legacy value to localAttachment.roots[thisOS] with provider 'custom'). All
	// runtime reads go through selectActiveRoot, never localRoot directly. The
	// offloaded file mirrors its vault-relative path under the resolved root, and
	// the pointer stores that path root-relative so it stays portable across
	// machines that mount the folder at different absolute locations.
	storageMode: StorageMode;
	localAttachment: LocalAttachmentSettings;
	localRoot: string;
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
	// Default to the historical S3-only behavior so an existing install is unchanged
	// until the user opts into a local folder.
	storageMode: 's3-only',
	// A fresh install starts with no local root on any OS; the user picks a provider
	// and sets this machine's slot in settings. 'custom' is the neutral default so a
	// blank install makes no provider claim.
	localAttachment: { provider: 'custom', subpath: '', roots: {} },
	localRoot: '',
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
