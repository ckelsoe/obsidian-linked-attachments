import { decodePointer, encodePointer, DecodedPointer, PointerRecord } from '../pointer/codec';

// Checkout state on the pointer note (spec section 4a). The pointer STAYS in place
// as the visible lineage anchor when a file is checked out; it shows the dirty state
// and carries the advisory cross-device lock. The lock has to ride the user's sync
// to be visible on another device, and the pointer note is exactly the small synced
// thing - so the checkout markers live in the pointer's frontmatter (as preserved
// la_* extras, keeping the section-5 schema lock intact), not in the device-local
// rebuildable manifest. The large editable working copy stays in the sync-excluded
// .linked-attachments/checkout/<sha>/ and never becomes a co-equal replica.

export const CHECKED_OUT_STATE = 'checked-out';
export const OFFLOADED_STATE = 'offloaded';

// Frontmatter keys for the advisory lock. Namespaced la_* so the codec preserves
// them as extras (forward-compatible; never a core-record field change).
const CHECKOUT_HOST_KEY = 'la_checkout_host';
const CHECKOUT_AT_KEY = 'la_checkout_at';
// The version (content hash) the working copy was checked out from. Kept so check-in
// can find the working copy and detect a conflict even if the pointer advanced via a
// forced remote check-in. Stored on the pointer (synced) for the same reasons as the
// host/time markers.
const CHECKOUT_BASE_HASH_KEY = 'la_checkout_base_hash';

// The sync-excluded working directory for editable checkouts (spec section 4a). A dot
// folder, so Obsidian does not index it and the user's sync does not carry it.
export const CHECKOUT_WORKING_DIR = '.linked-attachments/checkout';

export interface CheckoutInfo {
	host: string;
	at: string; // ISO timestamp of the checkout
}

// The working copy path for a checked-out version (spec section 4a:
// .linked-attachments/checkout/<sha>/<name>). <sha> is the base version's content
// hash, so each checkout has a unique sync-excluded directory.
export function workingCopyPath(baseHash: string, originalName: string): string {
	return `${CHECKOUT_WORKING_DIR}/${baseHash}/${originalName}`;
}

// orange = checked out / cloud untouched; red = local edits not in cloud; green =
// up to date (spec section 4a). The dirty state never claims green for a checked-out
// pointer, and never claims red unless the working copy genuinely differs.
export type DirtyState = 'up-to-date' | 'checked-out-clean' | 'checked-out-dirty';
export type DirtyColor = 'green' | 'orange' | 'red';

// Set the checkout markers: flip copyState to checked-out and record host + time
// (and optionally the base version hash), preserving identity, every other la_*
// field, the user body, and any other extras.
export function withCheckoutMarkers(text: string, info: CheckoutInfo & { baseHash?: string }): string {
	const decoded = decodePointer(text);
	const record: PointerRecord = { ...decoded.record, copyState: CHECKED_OUT_STATE };
	const extras: Record<string, unknown> = { ...decoded.extraFrontmatter, [CHECKOUT_HOST_KEY]: info.host, [CHECKOUT_AT_KEY]: info.at };
	if (info.baseHash !== undefined) {
		extras[CHECKOUT_BASE_HASH_KEY] = info.baseHash;
	}
	return encodePointer(record, decoded.body, extras);
}

// Clear the checkout markers: back to offloaded, remove every checkout marker.
export function clearCheckoutMarkers(text: string): string {
	const decoded = decodePointer(text);
	const record: PointerRecord = { ...decoded.record, copyState: OFFLOADED_STATE };
	return encodePointer(record, decoded.body, withoutCheckoutKeys(decoded.extraFrontmatter));
}

// Encode a checked-in pointer: the new (version) record, the user body preserved,
// and every checkout marker removed (the file is no longer checked out).
export function encodeCheckedIn(oldText: string, newRecord: PointerRecord): string {
	const decoded = decodePointer(oldText);
	return encodePointer(newRecord, decoded.body, withoutCheckoutKeys(decoded.extraFrontmatter));
}

// The base version hash recorded at checkout (or null when absent).
export function readCheckoutBase(decoded: DecodedPointer): string | null {
	const value = decoded.extraFrontmatter[CHECKOUT_BASE_HASH_KEY];
	return typeof value === 'string' && value.length > 0 ? value : null;
}

// Read the checkout markers from a decoded pointer, or null if it is not checked out.
export function readCheckout(decoded: DecodedPointer): CheckoutInfo | null {
	if (decoded.record.copyState !== CHECKED_OUT_STATE) {
		return null;
	}
	const host = decoded.extraFrontmatter[CHECKOUT_HOST_KEY];
	const at = coerceTimestamp(decoded.extraFrontmatter[CHECKOUT_AT_KEY]);
	if (typeof host !== 'string' || at === null) {
		return null;
	}
	return { host, at };
}

// Derive the dirty state from the record and the working copy's current hash (null
// when the working copy cannot be read). A checked-out pointer is never up-to-date.
export function dirtyState(record: PointerRecord, workingCopyHash: string | null): DirtyState {
	if (record.copyState !== CHECKED_OUT_STATE) {
		return 'up-to-date';
	}
	if (workingCopyHash !== null && record.hash !== null && workingCopyHash !== record.hash) {
		return 'checked-out-dirty';
	}
	return 'checked-out-clean';
}

export function dirtyColor(state: DirtyState): DirtyColor {
	switch (state) {
		case 'up-to-date':
			return 'green';
		case 'checked-out-clean':
			return 'orange';
		case 'checked-out-dirty':
			return 'red';
	}
}

export function dirtyLabel(state: DirtyState): string {
	switch (state) {
		case 'up-to-date':
			return 'Up to date';
		case 'checked-out-clean':
			return 'Checked out (cloud copy untouched)';
		case 'checked-out-dirty':
			return 'Checked out with edits not in the cloud';
	}
}

// --- internals --------------------------------------------------------------

function withoutCheckoutKeys(extras: Record<string, unknown>): Record<string, unknown> {
	const cleaned = { ...extras };
	delete cleaned[CHECKOUT_HOST_KEY];
	delete cleaned[CHECKOUT_AT_KEY];
	delete cleaned[CHECKOUT_BASE_HASH_KEY];
	return cleaned;
}

// Obsidian's Properties UI may coerce an ISO timestamp to a Date; accept both, like
// the codec does for required string fields.
function coerceTimestamp(value: unknown): string | null {
	if (value instanceof Date) {
		return value.toISOString();
	}
	return typeof value === 'string' && value.length > 0 ? value : null;
}
