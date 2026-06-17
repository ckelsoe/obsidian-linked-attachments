import { PointerRecord, VerificationTier } from '../pointer/codec';
import { StorageBackend } from '../storage/backend';

// STUB (la-p2-07 RED). Implementation lands in the GREEN commit.

export type OffloadStage = 'staged' | 'uploaded' | 'verified' | 'committed' | 'removed';

export interface OffloadFile {
	path: string;
	bytes: Uint8Array;
	contentType: string;
}

export interface VerifyExpectation {
	hash: string;
	checksumBase64: string;
	size: number;
}

export interface VerifyOutcome {
	ok: boolean;
	tier: VerificationTier;
	remoteChecksum: string | null;
	reason: string | null;
}

export type Verifier = (backend: StorageBackend, key: string, expectation: VerifyExpectation) => Promise<VerifyOutcome>;

export interface OffloadDeps {
	backend: StorageBackend;
	bucket: string;
	vaultPrefix: string;
	writePointer: (pointerPath: string, content: string) => Promise<void>;
	trashOriginal: (path: string) => Promise<void>;
	newId: () => string;
	now: () => string;
	verify?: Verifier;
	canRemoveOriginal?: (tier: VerificationTier) => boolean;
}

export interface OffloadResult {
	ok: boolean;
	reachedStage: OffloadStage;
	removed: boolean;
	record: PointerRecord | null;
	pointerPath: string | null;
	error: string | null;
}

export const checksumVerifier: Verifier = () => {
	throw new Error('not implemented');
};

export function defaultCanRemoveOriginal(_tier: VerificationTier): boolean {
	throw new Error('not implemented');
}

export function offloadFile(_file: OffloadFile, _deps: OffloadDeps): Promise<OffloadResult> {
	throw new Error('not implemented');
}
