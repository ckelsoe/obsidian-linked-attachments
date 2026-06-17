import { classifyError } from './error-state';
import { BackendError } from './backend';

// Auth-error state (spec section 4): classify auth failures distinctly from network
// errors, drive a refuse-all-destructive posture, and surface an honest "stale keys
// on this device" message - never a raw 403. The classifier reads a BackendError's
// kind exactly, and falls back to message markers for the stringified errors the
// offload pipeline surfaces, so both paths are honest.

describe('classifyError', () => {
	it('an auth BackendError is an auth state that refuses destructive ops', () => {
		const state = classifyError(new BackendError('auth', 'head k: authentication/authorization failed (HTTP 403 AccessDenied)'));
		expect(state.isAuth).toBe(true);
		expect(state.refuseDestructive).toBe(true);
		expect(state.message.toLowerCase()).toContain('stale');
		// honesty: never a raw 403 in the user message
		expect(state.message).not.toContain('403');
	});

	it('a network BackendError is not an auth failure and does not refuse', () => {
		const state = classifyError(new BackendError('network', 'list p: HTTP 500'));
		expect(state.isAuth).toBe(false);
		expect(state.refuseDestructive).toBe(false);
		expect(state.message.toLowerCase()).toContain('reach');
	});

	it('a checksum-mismatch is reported as an integrity failure, nothing removed', () => {
		const state = classifyError(new BackendError('checksum-mismatch', 'checksum mismatch for k'));
		expect(state.isAuth).toBe(false);
		expect(state.message.toLowerCase()).toContain('integrity');
	});

	it('a stringified auth message (from the pipeline) is still detected as auth', () => {
		const state = classifyError('upload failed: head k: authentication/authorization failed (HTTP 403)');
		expect(state.isAuth).toBe(true);
		expect(state.refuseDestructive).toBe(true);
	});

	it('a plain error is unknown, not an auth failure', () => {
		const state = classifyError(new Error('a pointer note already exists'));
		expect(state.kind).toBe('unknown');
		expect(state.isAuth).toBe(false);
		expect(state.refuseDestructive).toBe(false);
	});
});
