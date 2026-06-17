import { KeyKind, PointerRecord } from '../pointer/codec';

// STUB (la-p1-04 RED). Implementation lands in the GREEN commit.

export interface KeyInput {
	vaultPrefix: string;
	originalPath: string;
	hash: string;
	hashLength?: number;
}

export interface KeyAssignment {
	key: string;
	keyKind: KeyKind;
}

export interface SupersedingKeyAssignment extends KeyAssignment {
	supersedes: string;
}

export function layoutHashKey(_input: KeyInput): KeyAssignment {
	throw new Error('not implemented');
}

export function adoptExternalKey(_rawKey: string): KeyAssignment {
	throw new Error('not implemented');
}

export function supersedingKey(_input: KeyInput, _supersedesKey: string): SupersedingKeyAssignment {
	throw new Error('not implemented');
}

export function applyVaultRename(_record: PointerRecord, _newOriginalPath: string): PointerRecord {
	throw new Error('not implemented');
}
