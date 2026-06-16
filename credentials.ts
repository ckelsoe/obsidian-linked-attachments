// Secure credential storage for the S3-compatible storage backend.
//
// This is kept-seed production code, not throwaway. Every later acceptance
// criterion that needs the access key / secret key (the connection test and the
// signed PUT / GET / HEAD / LIST / DELETE) reads them through this module, never
// from a plaintext settings field.
//
// Division of responsibility, from the verified secretStorage API (since 1.11.4):
//   - The raw key material lives ONLY in Obsidian's per-vault secret storage,
//     entered through a SecretComponent in the settings UI. It never touches
//     data.json and never travels through Obsidian Sync.
//   - data.json holds only the NON-secret references: the secret IDs under which
//     secretStorage holds each key (CredentialRefs), plus endpoint/region/bucket.
//   - This module reads the values back via getSecret(id) at request time.
//
// The module intentionally has no `obsidian` import. It depends on a structural
// SecretStore (the three secretStorage methods), so it is fully unit-testable
// against a fake store with no Obsidian runtime.

// Structural view of Obsidian's SecretStorage (since 1.11.4). Obsidian's concrete
// SecretStorage class is assignable to this by shape, so the plugin passes
// `app.secretStorage` here directly.
export interface SecretStore {
	setSecret(id: string, secret: string): void;
	getSecret(id: string): string | null;
	listSecrets(): string[];
}

// S3 request-addressing style. Non-secret; lives in data.json.
export type S3AddressingStyle = 'path' | 'virtual-hosted';

// The decrypted key material, assembled on demand and never persisted.
export interface S3Credentials {
	accessKeyId: string;
	secretAccessKey: string;
}

// The data.json-resident pointers to the two secrets. Raw keys are NEVER stored
// here; only the secretStorage IDs under which they are held.
export interface CredentialRefs {
	accessKeyIdSecretName: string;
	secretAccessKeySecretName: string;
}

// secretStorage IDs must be lowercase alphanumeric with optional internal dashes;
// setSecret throws on anything else. Validate before any read so a bad name fails
// predictably here instead of deep inside a signed request.
const SECRET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSecretId(id: string): boolean {
	return SECRET_ID_PATTERN.test(id);
}

export class CredentialStore {
	constructor(
		private readonly secrets: SecretStore,
		private readonly refs: () => CredentialRefs,
	) {}

	getAccessKeyId(): string | null {
		return this.read(this.refs().accessKeyIdSecretName);
	}

	getSecretAccessKey(): string | null {
		return this.read(this.refs().secretAccessKeySecretName);
	}

	// Both secrets resolved and non-empty, or null. This is the single gate every
	// later AC reads before issuing a signed request: a null here means "not
	// configured", and the caller must refuse the network op rather than sign with
	// half a credential.
	getCredentials(): S3Credentials | null {
		const accessKeyId = this.getAccessKeyId();
		const secretAccessKey = this.getSecretAccessKey();
		if (accessKeyId === null || secretAccessKey === null) {
			return null;
		}
		return { accessKeyId, secretAccessKey };
	}

	hasCompleteCredentials(): boolean {
		return this.getCredentials() !== null;
	}

	// Reads one secret by name, normalizing "present but empty" to absent. An empty
	// string is a half-entered credential, not a usable value, so it is treated the
	// same as a missing secret.
	private read(id: string): string | null {
		if (id.length === 0 || !isValidSecretId(id)) {
			return null;
		}
		const value = this.secrets.getSecret(id);
		if (value === null || value.length === 0) {
			return null;
		}
		return value;
	}
}

// --- AC-G6: secretStorage round-trip probe -----------------------------------

// A dedicated probe ID, never a credential ID. There is no removeSecret in the
// secretStorage API, so the probe reuses one stable ID and overwrites its value
// with an empty string after the check. The ID stays visible in listSecrets() but
// holds nothing meaningful.
export const PROBE_SECRET_ID = 'linked-attachments-secretstorage-probe';

export interface SecretStorageProbe {
	available: boolean;   // the secretStorage API is present on this platform
	roundTripOk: boolean; // setSecret(id, v) then getSecret(id) returned v
	detail: string;       // human-readable summary for a notice and the console
}

// Proves setSecret -> getSecret round-trips a value. `nonce` is supplied by the
// caller so the probe stays deterministic and testable. The caller owns the
// platform-presence check (does app.secretStorage exist); this function assumes a
// store and reports the round-trip result.
export function runSecretStorageProbe(store: SecretStore, nonce: string): SecretStorageProbe {
	try {
		store.setSecret(PROBE_SECRET_ID, nonce);
		const readBack = store.getSecret(PROBE_SECRET_ID);
		const roundTripOk = readBack === nonce;
		// Best-effort scrub: no delete API exists, so blank the stored value.
		try {
			store.setSecret(PROBE_SECRET_ID, '');
		} catch (scrubError) {
			console.warn('Linked Attachments: could not scrub the secret storage probe value.', scrubError);
		}
		return {
			available: true,
			roundTripOk,
			detail: roundTripOk
				? 'Secret storage round-trip succeeded: a written value read back identically.'
				: `Secret storage round-trip failed: read back ${readBack === null ? 'null' : 'a different value'}.`,
		};
	} catch (error) {
		return {
			available: true,
			roundTripOk: false,
			detail: `Secret storage threw during the round-trip: ${describeError(error)}`,
		};
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
