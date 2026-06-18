import { KeyKind, PointerRecord } from '../pointer/codec';
import { PointerSource } from '../manifest/manifest';

// Content-dedup at offload (spec section 10 invariant). A hash -> existing-object
// lookup so offload never uploads a second object for bytes already in storage:
// identical bytes under a NEW vault path link to the existing object instead of
// minting a second key (the key mirrors the path, so without this pre-check the
// bucket accrues a redundant object - the move-then-re-offload duplicate).
//
// The index is REBUILDABLE from the vault's pointer notes (the source of truth);
// it is not a new datastore and is not synced. One object may be referenced by N
// pointers - expected, and the reason a future GC must ref-count before reclaiming
// (spec section 7 Phase 4+). There is no "keep a separate copy" option:
// content-addressing makes a duplicate pointless (deferred as YAGNI).

export interface DedupTarget {
	key: string;
	bucket: string;
	keyKind: KeyKind;
}

export type HashIndex = Map<string, DedupTarget>;

// Build the hash -> object index from pointer records. Only objects with a known
// content hash are dedup targets: an adopted/foreign pointer has hash null (its
// bytes are asserted, never verified), so it can never authorize linking another
// file to it. The first pointer for a given hash wins (stable; any is correct).
export function buildHashIndex(sources: PointerSource[]): HashIndex {
	const index: HashIndex = new Map();
	for (const { record } of sources) {
		rememberObject(index, record);
	}
	return index;
}

// Add a just-offloaded object to a live index so a later identical file in the
// same batch dedups against it (the vault scan that built the index predates this
// offload). A null-hash record is never a target; an already-present hash is kept.
export function rememberObject(index: HashIndex, record: PointerRecord): void {
	if (record.hash === null || index.has(record.hash)) {
		return;
	}
	index.set(record.hash, { key: record.key, bucket: record.bucket, keyKind: record.keyKind });
}

export function lookupByHash(index: HashIndex, hash: string): DedupTarget | null {
	return index.get(hash) ?? null;
}
