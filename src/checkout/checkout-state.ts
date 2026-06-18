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

export interface CheckoutInfo {
	host: string;
	at: string; // ISO timestamp of the checkout
}

// orange = checked out / cloud untouched; red = local edits not in cloud; green =
// up to date (spec section 4a). The dirty state never claims green for a checked-out
// pointer, and never claims red unless the working copy genuinely differs.
export type DirtyState = 'up-to-date' | 'checked-out-clean' | 'checked-out-dirty';
export type DirtyColor = 'green' | 'orange' | 'red';

// Set the checkout markers: flip copyState to checked-out and record host + time,
// preserving identity, every other la_* field, the user body, and any other extras.
export function withCheckoutMarkers(text: string, info: CheckoutInfo): string {
	const decoded = decodePointer(text);
	const record: PointerRecord = { ...decoded.record, copyState: CHECKED_OUT_STATE };
	const extras = { ...decoded.extraFrontmatter, [CHECKOUT_HOST_KEY]: info.host, [CHECKOUT_AT_KEY]: info.at };
	return encodePointer(record, decoded.body, extras);
}

// Clear the checkout markers: back to offloaded, remove host + time.
export function clearCheckoutMarkers(text: string): string {
	const decoded = decodePointer(text);
	const record: PointerRecord = { ...decoded.record, copyState: OFFLOADED_STATE };
	const extras = { ...decoded.extraFrontmatter };
	delete extras[CHECKOUT_HOST_KEY];
	delete extras[CHECKOUT_AT_KEY];
	return encodePointer(record, decoded.body, extras);
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

// Obsidian's Properties UI may coerce an ISO timestamp to a Date; accept both, like
// the codec does for required string fields.
function coerceTimestamp(value: unknown): string | null {
	if (value instanceof Date) {
		return value.toISOString();
	}
	return typeof value === 'string' && value.length > 0 ? value : null;
}
