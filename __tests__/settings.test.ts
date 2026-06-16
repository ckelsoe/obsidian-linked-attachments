import {
	DEFAULT_SETTINGS,
	DEFAULT_ACCESS_KEY_SECRET_ID,
	DEFAULT_SECRET_KEY_SECRET_ID,
} from '../settings';
import { isValidSecretId } from '../credentials';

describe('default secret IDs', () => {
	it('are valid secretStorage IDs (so setSecret will not throw on them)', () => {
		expect(isValidSecretId(DEFAULT_ACCESS_KEY_SECRET_ID)).toBe(true);
		expect(isValidSecretId(DEFAULT_SECRET_KEY_SECRET_ID)).toBe(true);
	});

	it('are distinct, so the two credentials never alias one secret', () => {
		expect(DEFAULT_ACCESS_KEY_SECRET_ID).not.toBe(DEFAULT_SECRET_KEY_SECRET_ID);
	});

	it('are namespaced with the plugin ID to avoid colliding with other plugins', () => {
		expect(DEFAULT_ACCESS_KEY_SECRET_ID.startsWith('linked-attachments-')).toBe(true);
		expect(DEFAULT_SECRET_KEY_SECRET_ID.startsWith('linked-attachments-')).toBe(true);
	});

	it('are wired into the default settings the plugin loads', () => {
		expect(DEFAULT_SETTINGS.accessKeyIdSecretName).toBe(DEFAULT_ACCESS_KEY_SECRET_ID);
		expect(DEFAULT_SETTINGS.secretAccessKeySecretName).toBe(DEFAULT_SECRET_KEY_SECRET_ID);
	});
});
