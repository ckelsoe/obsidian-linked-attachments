import { PointerRecord } from '../pointer/codec';
import { StorageBackend } from '../storage/backend';

// STUB (la-p2-09 RED). Implementation lands in the GREEN commit.

export type AdoptRowStatus = 'adoptable' | 'already-adopted' | 'collision';

export interface AdoptRow {
	key: string;
	displayName: string;
	size: number;
	vaultPath: string;
	pointerPath: string;
	status: AdoptRowStatus;
}

export interface AdoptScanInput {
	backend: StorageBackend;
	prefix?: string;
	stripPrefix?: string;
	destinationFolder?: string;
	existingPointerKeys: Set<string>;
	existingVaultPaths: Set<string>;
	pageSize?: number;
}

export interface AdoptScanResult {
	rows: AdoptRow[];
	listCalls: number;
}

export interface AdoptOptions {
	bucket: string;
	newId: () => string;
	now: () => string;
}

export interface AdoptedPointer {
	pointerPath: string;
	record: PointerRecord;
}

export interface KeyPlacement {
	vaultPath: string;
}

export type AdoptByKeyResult = AdoptedPointer | { collision: true };

export function scanForAdoption(_input: AdoptScanInput): Promise<AdoptScanResult> {
	throw new Error('not implemented');
}

export function buildAdoptedPointer(_row: AdoptRow, _options: AdoptOptions): AdoptedPointer {
	throw new Error('not implemented');
}

export function adoptByKey(
	_backend: StorageBackend,
	_key: string,
	_placement: KeyPlacement,
	_options: AdoptOptions,
): Promise<AdoptByKeyResult> {
	throw new Error('not implemented');
}
