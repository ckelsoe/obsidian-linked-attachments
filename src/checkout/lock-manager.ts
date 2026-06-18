import { CheckoutInfo } from './checkout-state';

// The advisory cross-device lock (spec section 4a). There is no server, so the lock
// is ADVISORY: it is evaluated from the pointer's checkout markers (which ride the
// user's sync), and the UI warns + defaults to read-only on another device, with a
// force escape for a stale lock. Never claim enforcement. Pure: markers + this host
// + a clock in, a verdict out.

export type LockState = 'free' | 'held-by-me' | 'held-by-other' | 'stale';

export interface LockQuery {
	checkout: CheckoutInfo | null;
	thisHost: string;
	nowMs: number;
	staleAfterMs: number;
}

export interface LockVerdict {
	state: LockState;
	message: string;
}

export function evaluateLock(query: LockQuery): LockVerdict {
	const { checkout, thisHost, nowMs, staleAfterMs } = query;
	if (checkout === null) {
		return { state: 'free', message: '' };
	}
	if (checkout.host === thisHost) {
		return { state: 'held-by-me', message: 'You have this checked out on this device.' };
	}
	const atMs = Date.parse(checkout.at);
	const since = `${checkout.host} since ${checkout.at}`;
	// An unparseable timestamp cannot be proven stale, so treat it as a live lock.
	if (Number.isNaN(atMs) || nowMs - atMs <= staleAfterMs) {
		return { state: 'held-by-other', message: `Checked out on ${since}. Open as read-only to avoid a conflict.` };
	}
	return { state: 'stale', message: `Checked out on ${since}, but that lock looks stale. You can force a checkout.` };
}

// Name the preserved loser of a conflicting check-in (LWW + detect-and-preserve-both,
// never a merge engine - spec section 4a). Recognizable like an Obsidian Sync
// conflict file: the marker is inserted before the extension so the type is kept.
export function conflictCopyName(originalName: string, host: string, at: string): string {
	const stamp = at.replace(/[:.]/g, '-');
	const dot = originalName.lastIndexOf('.');
	if (dot <= 0) {
		return `${originalName} (conflict from ${host} ${stamp})`;
	}
	const stem = originalName.slice(0, dot);
	const ext = originalName.slice(dot); // includes the leading dot
	return `${stem} (conflict from ${host} ${stamp})${ext}`;
}
