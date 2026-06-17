import { pointerTrustLine, offloadOutcomeLine } from './trust-summary';
import { PointerRecord, VerificationTier } from '../pointer/codec';
import { OffloadResult } from '../offload/pipeline';

// The user-facing trust copy that surfaces the badge (development-plan section 8).
// Pure so the wording is falsifiable: a pointer's line names its badge and card
// line, and an offload outcome states the achieved tier and whether the original
// was removed - never claiming a delete that did not happen.

const record = (tier: VerificationTier): PointerRecord => ({
	laVersion: 1,
	id: 'id',
	hash: 'h',
	bucket: 'b',
	key: 'k',
	keyKind: 'hash',
	originalName: 'file.pdf',
	originalExt: 'pdf',
	originalPath: 'file.pdf',
	byteSize: 1,
	contentType: 'application/pdf',
	copyState: 'offloaded',
	verificationTier: tier,
	remoteChecksum: null,
	checksumAlgo: 'sha256',
	partSize: null,
	partCount: null,
	offloadedAt: '2026-06-17T00:00:00.000Z',
	sourceVersion: null,
	supersedes: null,
});

describe('pointerTrustLine', () => {
	it('names the badge and card line for a verified pointer', () => {
		expect(pointerTrustLine(record('content'))).toBe('Verified: Confirmed byte-for-byte');
	});
	it('names Found for an existence-verified pointer', () => {
		expect(pointerTrustLine(record('existence'))).toBe('Found: We see it exists');
	});
	it('names Asserted for an adopted pointer', () => {
		expect(pointerTrustLine(record('asserted'))).toBe('Asserted: You told us it\'s there');
	});
});

describe('offloadOutcomeLine', () => {
	const base: OffloadResult = {
		ok: true,
		reachedStage: 'removed',
		removed: true,
		record: record('content'),
		pointerPath: 'file.pdf.md',
		error: null,
	};

	it('reports a verified, removed offload', () => {
		const line = offloadOutcomeLine('file.pdf', base);
		expect(line).toContain('Verified');
		expect(line).toContain('moved to trash');
	});

	it('reports a kept original when the tier did not clear the gate', () => {
		const line = offloadOutcomeLine('file.pdf', { ...base, removed: false, reachedStage: 'committed' });
		expect(line).toContain('kept');
		expect(line).not.toContain('moved to trash');
	});

	it('reports a failed offload without claiming any deletion', () => {
		const line = offloadOutcomeLine('file.pdf', { ok: false, reachedStage: 'uploaded', removed: false, record: record('asserted'), pointerPath: 'file.pdf.md', error: 'verify failed' });
		expect(line).toContain('not removed');
		expect(line).toContain('verify failed');
	});
});
