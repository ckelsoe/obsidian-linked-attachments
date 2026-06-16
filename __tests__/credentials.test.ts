import {
	CredentialStore,
	CredentialRefs,
	SecretStore,
	isValidSecretId,
	runSecretStorageProbe,
	PROBE_SECRET_ID,
} from '../credentials';

// A fake secret store that enforces the same ID rule Obsidian's setSecret does
// (lowercase alphanumeric with optional internal dashes; throws otherwise), so
// tests exercise the real validation contract without an Obsidian runtime.
class FakeSecretStore implements SecretStore {
	private store = new Map<string, string>();

	setSecret(id: string, secret: string): void {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
			throw new Error(`invalid secret id: ${id}`);
		}
		this.store.set(id, secret);
	}

	getSecret(id: string): string | null {
		const value = this.store.get(id);
		return value === undefined ? null : value;
	}

	listSecrets(): string[] {
		return [...this.store.keys()];
	}
}

const REFS: CredentialRefs = {
	accessKeyIdSecretName: 'la-access-key',
	secretAccessKeySecretName: 'la-secret-key',
};

describe('isValidSecretId', () => {
	it('accepts lowercase alphanumeric with internal dashes', () => {
		expect(isValidSecretId('abc')).toBe(true);
		expect(isValidSecretId('a1')).toBe(true);
		expect(isValidSecretId('linked-attachments-access-key-id')).toBe(true);
	});

	it('rejects empty, uppercase, underscores, and edge dashes', () => {
		expect(isValidSecretId('')).toBe(false);
		expect(isValidSecretId('Abc')).toBe(false);
		expect(isValidSecretId('a_b')).toBe(false);
		expect(isValidSecretId('-a')).toBe(false);
		expect(isValidSecretId('a-')).toBe(false);
		expect(isValidSecretId('a--b')).toBe(false);
		expect(isValidSecretId('a b')).toBe(false);
	});
});

describe('CredentialStore.getCredentials', () => {
	it('returns null when neither secret is set', () => {
		const store = new FakeSecretStore();
		const creds = new CredentialStore(store, () => REFS);
		expect(creds.getCredentials()).toBeNull();
		expect(creds.hasCompleteCredentials()).toBe(false);
	});

	it('returns null when only one secret is set', () => {
		const store = new FakeSecretStore();
		store.setSecret(REFS.accessKeyIdSecretName, 'AKIAEXAMPLE');
		const creds = new CredentialStore(store, () => REFS);
		expect(creds.getCredentials()).toBeNull();
	});

	it('returns both values when both secrets are set', () => {
		const store = new FakeSecretStore();
		store.setSecret(REFS.accessKeyIdSecretName, 'AKIAEXAMPLE');
		store.setSecret(REFS.secretAccessKeySecretName, 'super-secret-value');
		const creds = new CredentialStore(store, () => REFS);
		expect(creds.getCredentials()).toEqual({
			accessKeyId: 'AKIAEXAMPLE',
			secretAccessKey: 'super-secret-value',
		});
		expect(creds.hasCompleteCredentials()).toBe(true);
	});

	it('treats a present-but-empty secret as absent', () => {
		const store = new FakeSecretStore();
		store.setSecret(REFS.accessKeyIdSecretName, 'AKIAEXAMPLE');
		store.setSecret(REFS.secretAccessKeySecretName, '');
		const creds = new CredentialStore(store, () => REFS);
		expect(creds.getCredentials()).toBeNull();
	});

	it('returns null when a configured name is empty or invalid', () => {
		const store = new FakeSecretStore();
		store.setSecret(REFS.accessKeyIdSecretName, 'AKIAEXAMPLE');
		// An empty access-key name cannot resolve a secret.
		const emptyName = new CredentialStore(store, () => ({
			accessKeyIdSecretName: '',
			secretAccessKeySecretName: REFS.secretAccessKeySecretName,
		}));
		expect(emptyName.getAccessKeyId()).toBeNull();
	});

	it('reads the secret named by the live refs getter, so a name change is picked up', () => {
		const store = new FakeSecretStore();
		store.setSecret('first-key', 'first-value');
		store.setSecret('second-key', 'second-value');
		const refs: CredentialRefs = {
			accessKeyIdSecretName: 'first-key',
			secretAccessKeySecretName: REFS.secretAccessKeySecretName,
		};
		const creds = new CredentialStore(store, () => refs);
		expect(creds.getAccessKeyId()).toBe('first-value');
		refs.accessKeyIdSecretName = 'second-key';
		expect(creds.getAccessKeyId()).toBe('second-value');
	});
});

describe('runSecretStorageProbe (AC-G6)', () => {
	it('reports a successful round-trip and blanks the probe value afterward', () => {
		const store = new FakeSecretStore();
		const result = runSecretStorageProbe(store, 'nonce-123');
		expect(result.available).toBe(true);
		expect(result.roundTripOk).toBe(true);
		expect(result.detail).toContain('succeeded');
		// No delete API exists, so the probe ID remains but is scrubbed to empty.
		expect(store.getSecret(PROBE_SECRET_ID)).toBe('');
	});

	it('reports a failed round-trip when the store does not return what was written', () => {
		// A store that silently drops writes: getSecret never returns the nonce.
		const droppingStore: SecretStore = {
			setSecret: () => undefined,
			getSecret: () => null,
			listSecrets: () => [],
		};
		const result = runSecretStorageProbe(droppingStore, 'nonce-123');
		expect(result.available).toBe(true);
		expect(result.roundTripOk).toBe(false);
		expect(result.detail).toContain('failed');
	});

	it('reports a failed round-trip when the store throws', () => {
		const throwingStore: SecretStore = {
			setSecret: () => { throw new Error('storage backend offline'); },
			getSecret: () => null,
			listSecrets: () => [],
		};
		const result = runSecretStorageProbe(throwingStore, 'nonce-123');
		expect(result.roundTripOk).toBe(false);
		expect(result.detail).toContain('storage backend offline');
	});
});
