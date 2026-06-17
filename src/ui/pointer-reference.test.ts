import { formatPointerReference } from './pointer-reference';
import { PointerRecord, VerificationTier } from '../pointer/codec';

// The mobile pointer affordance (spec section 3 mobile / section 4 v1): v1 does not
// do in-app mobile transport, so what it owes the mobile user is a pointer that
// resolves to ACTIONABLE IDENTITY (a copyable key + reference) and HONEST size and
// format, so they can open it in their own S3 app and decide before pulling on
// cellular. This formatter is that reference; it is pure and testable. The device
// share-sheet handoff is the parked real-device test.

const record = (over: Partial<PointerRecord> = {}): PointerRecord => ({
	laVersion: 1,
	id: 'id',
	hash: 'abc123',
	bucket: 'my-bucket',
	key: 'books/Romans/Cranfield--9f86d0.pdf',
	keyKind: 'hash',
	originalName: 'Cranfield.pdf',
	originalExt: 'pdf',
	originalPath: 'books/Romans/Cranfield.pdf',
	byteSize: 5 * 1024 * 1024,
	contentType: 'application/pdf',
	copyState: 'offloaded',
	verificationTier: 'content' as VerificationTier,
	remoteChecksum: null,
	checksumAlgo: 'sha256',
	partSize: null,
	partCount: null,
	offloadedAt: '2026-06-17T00:00:00.000Z',
	sourceVersion: null,
	supersedes: null,
	...over,
});

describe('formatPointerReference', () => {
	it('includes the honest name, size, and format', () => {
		const ref = formatPointerReference(record());
		expect(ref).toContain('Cranfield.pdf');
		expect(ref).toContain('5.0 MB');
		expect(ref).toContain('application/pdf');
	});

	it('includes the bucket and the exact object key (the actionable identity)', () => {
		const ref = formatPointerReference(record());
		expect(ref).toContain('my-bucket');
		expect(ref).toContain('books/Romans/Cranfield--9f86d0.pdf');
	});

	it('tells the mobile user how to act on it', () => {
		expect(formatPointerReference(record()).toLowerCase()).toContain('s3 app');
	});

	it('handles an adopted pointer with no content type or hash', () => {
		const ref = formatPointerReference(record({ contentType: '', hash: null }));
		expect(ref).toContain('Cranfield.pdf');
		expect(ref).toContain('my-bucket');
	});
});
