import { VerificationTier } from '../pointer/codec';
import { StorageBackend } from '../storage/backend';
import { Verifier } from './pipeline';

// STUB (la-p2-08 RED). Implementation lands in the GREEN commit.

export interface LadderExpectation {
	hash: string;
	checksumBase64: string;
	size: number;
	md5Hex?: string;
}

export interface LadderResult {
	tier: VerificationTier;
	remoteChecksum: string | null;
	reason: string | null;
}

export interface DeleteGateConfig {
	minimumTier?: VerificationTier;
	allowAssertedDelete?: boolean;
}

export interface DeleteDecision {
	deleted: boolean;
	refused: boolean;
	achievedTier: VerificationTier;
	remoteChecksum: string | null;
	reason: string | null;
}

export function verifyByLadder(_backend: StorageBackend, _key: string, _expectation: LadderExpectation): Promise<LadderResult> {
	throw new Error('not implemented');
}

export function canHardDelete(_tier: VerificationTier, _config?: DeleteGateConfig): boolean {
	throw new Error('not implemented');
}

export function verifyBeforeDelete(
	_backend: StorageBackend,
	_key: string,
	_expectation: LadderExpectation,
	_doDelete: () => Promise<void>,
	_config?: DeleteGateConfig,
): Promise<DeleteDecision> {
	throw new Error('not implemented');
}

export const ladderVerifier: Verifier = () => {
	throw new Error('not implemented');
};
