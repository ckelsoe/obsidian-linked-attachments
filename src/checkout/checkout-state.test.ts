import {
	withCheckoutMarkers,
	clearCheckoutMarkers,
	readCheckout,
	dirtyState,
	dirtyColor,
	dirtyLabel,
	CHECKED_OUT_STATE,
} from './checkout-state';
import { encodePointer, decodePointer, PointerRecord } from '../pointer/codec';

// Tier 0: the checkout state lives in the pointer note's frontmatter (it rides the
// user's sync, so another device sees the checkout - spec section 4a). These pure
// functions set/clear the markers and derive the dirty state. No vault, no network.

function record(overrides: Partial<PointerRecord> = {}): PointerRecord {
	return {
		laVersion: 1,
		id: 'ptr-1',
		hash: 'a'.repeat(64),
		bucket: 's3-dev-test',
		key: 'charles-main/budget--aaaaaa.xlsx',
		keyKind: 'hash',
		originalName: 'budget.xlsx',
		originalExt: 'xlsx',
		originalPath: 'finance/budget.xlsx',
		byteSize: 2048,
		contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		copyState: 'offloaded',
		verificationTier: 'content',
		remoteChecksum: null,
		checksumAlgo: 'sha256',
		partSize: null,
		partCount: null,
		offloadedAt: '2026-06-18T00:00:00.000Z',
		sourceVersion: null,
		supersedes: null,
		...overrides,
	};
}

function pointerText(rec: PointerRecord, body = 'My notes about the budget.\n'): string {
	return encodePointer(rec, body);
}

describe('checkout markers (la-p6-30)', () => {
	// AC1 :: withCheckoutMarkers flips copyState to checked-out and records host+time
	// in frontmatter (so a synced pointer carries the advisory lock).
	it('test_sets_checkout_markers', () => {
		const text = withCheckoutMarkers(pointerText(record()), { host: 'charles-mbp', at: '2026-06-18T10:00:00.000Z' });
		const decoded = decodePointer(text);
		expect(decoded.record.copyState).toBe(CHECKED_OUT_STATE);
		const info = readCheckout(decoded);
		expect(info).toEqual({ host: 'charles-mbp', at: '2026-06-18T10:00:00.000Z' });
	});

	// AC2 :: clearCheckoutMarkers returns to offloaded and removes the markers.
	it('test_clears_checkout_markers', () => {
		const checkedOut = withCheckoutMarkers(pointerText(record()), { host: 'h', at: '2026-06-18T10:00:00.000Z' });
		const cleared = clearCheckoutMarkers(checkedOut);
		const decoded = decodePointer(cleared);
		expect(decoded.record.copyState).toBe('offloaded');
		expect(readCheckout(decoded)).toBeNull();
	});

	// AC3 :: the user body and identity survive setting and clearing markers (the
	// pointer stays the lineage anchor; section 4a).
	it('test_body_and_identity_preserved', () => {
		const original = pointerText(record(), 'Important user notes.\nLine two.\n');
		const roundTripped = clearCheckoutMarkers(withCheckoutMarkers(original, { host: 'h', at: '2026-06-18T10:00:00.000Z' }));
		const decoded = decodePointer(roundTripped);
		expect(decoded.body).toBe('Important user notes.\nLine two.\n');
		expect(decoded.record.id).toBe('ptr-1');
		expect(decoded.record.hash).toBe('a'.repeat(64));
	});

	// AC4 :: readCheckout returns null for an offloaded (not checked-out) pointer.
	it('test_read_checkout_null_when_offloaded', () => {
		expect(readCheckout(decodePointer(pointerText(record())))).toBeNull();
	});
});

describe('dirty state (la-p6-30)', () => {
	// AC5 :: a not-checked-out pointer is up to date (green).
	it('test_offloaded_is_up_to_date', () => {
		const state = dirtyState(record(), null);
		expect(state).toBe('up-to-date');
		expect(dirtyColor(state)).toBe('green');
	});

	// AC6 :: checked out with the working copy still matching the cloud bytes is
	// orange (checked out / cloud untouched).
	it('test_checked_out_clean_is_orange', () => {
		const rec = record({ copyState: CHECKED_OUT_STATE });
		const state = dirtyState(rec, rec.hash);
		expect(state).toBe('checked-out-clean');
		expect(dirtyColor(state)).toBe('orange');
	});

	// AC7 :: checked out with an edited working copy (hash differs) is red (local
	// edits not in cloud).
	it('test_checked_out_dirty_is_red', () => {
		const rec = record({ copyState: CHECKED_OUT_STATE });
		const state = dirtyState(rec, 'b'.repeat(64));
		expect(state).toBe('checked-out-dirty');
		expect(dirtyColor(state)).toBe('red');
	});

	// AC8 :: checked out but the working copy hash is unknown -> treated as orange
	// (checked out), never falsely green.
	it('test_checked_out_unknown_working_copy_is_orange', () => {
		const rec = record({ copyState: CHECKED_OUT_STATE });
		expect(dirtyColor(dirtyState(rec, null))).toBe('orange');
	});

	it('test_dirty_label_is_human', () => {
		expect(dirtyLabel('up-to-date')).toMatch(/up to date/i);
		expect(dirtyLabel('checked-out-clean')).toMatch(/checked out/i);
		expect(dirtyLabel('checked-out-dirty')).toMatch(/not.*cloud|unsaved|edits/i);
	});
});
