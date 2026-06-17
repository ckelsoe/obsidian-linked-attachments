// STUB (la-p1-02 RED). Implementation lands in the GREEN commit.

export type KeyKind = 'hash' | 'external';
export type VerificationTier = 'content' | 'md5' | 'existence' | 'asserted';

// The pointer record: the in-memory form of a pointer note's machine fields
// (spec section 5). Serialized to / from `la_*`-namespaced frontmatter by the
// codec. Nullable fields are null for foreign adopted objects (hash) and
// single-part / non-multipart uploads (remoteChecksum, partSize, partCount).
export interface PointerRecord {
	laVersion: number;
	id: string;
	hash: string | null;
	bucket: string;
	key: string;
	keyKind: KeyKind;
	originalName: string;
	originalExt: string;
	originalPath: string;
	byteSize: number;
	contentType: string;
	copyState: string;
	verificationTier: VerificationTier;
	remoteChecksum: string | null;
	checksumAlgo: string | null;
	partSize: number | null;
	partCount: number | null;
	offloadedAt: string;
	sourceVersion: string | null;
	supersedes: string | null;
}

export interface DecodedPointer {
	record: PointerRecord;
	body: string;
	extraFrontmatter: Record<string, unknown>;
}

export class PointerParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PointerParseError';
	}
}

export function extractExtension(_name: string): string {
	throw new Error('not implemented');
}

export function encodePointer(_record: PointerRecord, _body: string, _extraFrontmatter?: Record<string, unknown>): string {
	throw new Error('not implemented');
}

export function decodePointer(_text: string): DecodedPointer {
	throw new Error('not implemented');
}

export function refreshManagedBlock(_text: string, _record: PointerRecord): string {
	throw new Error('not implemented');
}
