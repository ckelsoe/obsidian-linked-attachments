import { BackendError, BackendErrorKind } from './backend';

// Auth-error state (spec section 4). Turn any caught error into an honest, plain
// user-facing state: whether it is an authentication failure (stale keys on this
// device), whether destructive operations must be refused, and a message that never
// shows a raw 403. Reads a BackendError's kind exactly; for the stringified errors
// the offload pipeline surfaces, it falls back to message markers so both paths stay
// honest. Recovery for an auth failure is re-entering the keys in settings.

export interface ErrorState {
	kind: BackendErrorKind | 'unknown';
	isAuth: boolean;
	refuseDestructive: boolean;
	message: string;
}

const AUTH_MARKERS = [
	'authentication/authorization failed',
	'accessdenied',
	'invalidaccesskeyid',
	'signaturedoesnotmatch',
	'expiredtoken',
	'credentials are not configured',
];

export function classifyError(error: unknown): ErrorState {
	if (error instanceof BackendError) {
		return forKind(error.kind);
	}
	const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
	if (AUTH_MARKERS.some((marker) => text.includes(marker))) {
		return forKind('auth');
	}
	if (text.includes('could not reach') || text.includes('network')) {
		return forKind('network');
	}
	return { kind: 'unknown', isAuth: false, refuseDestructive: false, message: error instanceof Error ? error.message : String(error) };
}

function forKind(kind: BackendErrorKind): ErrorState {
	switch (kind) {
		case 'auth':
			// A stale-creds device must never attempt a delete or overwrite.
			return { kind, isAuth: true, refuseDestructive: true, message: 'Your storage keys look stale on this device. Re-enter them in settings; nothing was changed.' };
		case 'network':
			return { kind, isAuth: false, refuseDestructive: false, message: 'Could not reach your storage (network error). Nothing was changed.' };
		case 'checksum-mismatch':
			return { kind, isAuth: false, refuseDestructive: false, message: 'The upload failed an integrity check, so nothing was removed.' };
		case 'precondition-failed':
			return { kind, isAuth: false, refuseDestructive: false, message: 'The object changed under you, so nothing was overwritten.' };
		case 'not-found':
			return { kind, isAuth: false, refuseDestructive: false, message: 'The object was not found in your bucket.' };
		default:
			return { kind, isAuth: false, refuseDestructive: false, message: 'The storage operation did not complete.' };
	}
}
