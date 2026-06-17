import fc from 'fast-check';
import {
	PointerRecord,
	PointerParseError,
	encodePointer,
	decodePointer,
	extractExtension,
	refreshManagedBlock,
} from './codec';
import { MANAGED_END, MANAGED_START } from './managed-block';

// Tier 0: pure string/record codec. No backend, no network, no shared fixtures.

// A fully-populated record exercising every section-5 field, including the
// nullable ones set to non-null so the round-trip covers them.
function fullRecord(): PointerRecord {
	return {
		laVersion: 1,
		id: '01J9Z0K3QECRANFIELD',
		hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
		bucket: 's3-dev-test',
		key: 'charles-main/31-books/Romans/Cranfield--9f86d0.pdf',
		keyKind: 'hash',
		originalName: 'Cranfield.pdf',
		originalExt: 'pdf',
		originalPath: '31-books/Romans/Cranfield.pdf',
		byteSize: 1048576,
		contentType: 'application/pdf',
		copyState: 'offloaded',
		verificationTier: 'content',
		remoteChecksum: 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=',
		checksumAlgo: 'sha256',
		partSize: 8388608,
		partCount: 1,
		offloadedAt: '2026-06-16T12:00:00.000Z',
		sourceVersion: 'v1',
		supersedes: 'charles-main/31-books/Romans/Cranfield--0a1b2c.pdf',
	};
}

const USER_BODY = 'My reading notes on Cranfield.\n\n- chapter 1 is dense\n- see also [[Romans overview]]\n';

describe('pointer codec acceptance (la-p1-02)', () => {
	// AC1 :: every section-5 la_* field survives encode then decode unchanged.
	it('test_frontmatter_roundtrip', () => {
		const record = fullRecord();
		const text = encodePointer(record, USER_BODY);
		const decoded = decodePointer(text);
		expect(decoded.record).toEqual(record);
	});

	// AC1b :: the nullable fields round-trip as null (foreign / single-part cases).
	it('test_nullable_fields_roundtrip', () => {
		const record: PointerRecord = {
			...fullRecord(),
			hash: null,
			remoteChecksum: null,
			checksumAlgo: null,
			partSize: null,
			partCount: null,
			sourceVersion: null,
			supersedes: null,
			keyKind: 'external',
			verificationTier: 'asserted',
		};
		const decoded = decodePointer(encodePointer(record, ''));
		expect(decoded.record).toEqual(record);
	});

	// AC2 :: originalExt is the substring after the last dot; "a.b.tar.gz" -> "gz".
	it('test_multidot_ext', () => {
		expect(extractExtension('a.b.tar.gz')).toBe('gz');
		expect(extractExtension('Cranfield.pdf')).toBe('pdf');
		expect(extractExtension('no-extension')).toBe('');
		expect(extractExtension('.dotfile')).toBe('');
		expect(extractExtension('trailing.')).toBe('');
	});

	// AC3 :: the managed block regenerates between the markers; bytes outside the
	// markers (frontmatter values and the user body) are untouched.
	it('test_managed_block_regen', () => {
		const record = fullRecord();
		const text = encodePointer(record, USER_BODY);
		// A record whose id/name change the managed link, but identity is the same.
		const renamed: PointerRecord = { ...record, originalName: 'Cranfield-renamed.pdf' };
		const refreshed = refreshManagedBlock(text, renamed);
		expect(refreshed).toContain('Cranfield-renamed.pdf');
		// The body below the end marker is identical.
		const bodyAfter = refreshed.slice(refreshed.indexOf(MANAGED_END) + MANAGED_END.length);
		const bodyBefore = text.slice(text.indexOf(MANAGED_END) + MANAGED_END.length);
		expect(bodyAfter).toBe(bodyBefore);
	});

	// AC4 :: decode then re-encode leaves the user body below the end marker
	// byte-identical (spec section 10 pointer-is-truth, body is user-owned).
	it('test_body_never_written', () => {
		const record = fullRecord();
		const text = encodePointer(record, USER_BODY);
		const decoded = decodePointer(text);
		expect(decoded.body).toBe(USER_BODY);
		const reencoded = encodePointer(decoded.record, decoded.body);
		expect(decodePointer(reencoded).body).toBe(USER_BODY);
	});

	// AC5 :: identity is read from frontmatter; corrupting the body's open link
	// does NOT change the decoded record (spec section 3, body never authoritative).
	it('test_scanner_reads_fm_only', () => {
		const record = fullRecord();
		const text = encodePointer(record, USER_BODY);
		const tampered = text.replace(
			/obsidian:\/\/linked-attachments[^)]*/,
			'obsidian://linked-attachments?action=open&id=TAMPERED',
		);
		const decoded = decodePointer(tampered);
		expect(decoded.record.id).toBe(record.id);
		expect(decoded.record).toEqual(record);
	});

	// AC6 :: non-la_ frontmatter keys (e.g. user tags) survive the round-trip.
	it('test_extra_frontmatter_preserved', () => {
		const record = fullRecord();
		const text = encodePointer(record, USER_BODY, { tags: ['archive', 'romans'] });
		const decoded = decodePointer(text);
		expect(decoded.extraFrontmatter).toEqual({ tags: ['archive', 'romans'] });
		const reencoded = encodePointer(decoded.record, decoded.body, decoded.extraFrontmatter);
		expect(decodePointer(reencoded).extraFrontmatter).toEqual({ tags: ['archive', 'romans'] });
	});
});

describe('pointer codec property tests (la-p1-02)', () => {
	// prop_user_body_survives_refresh :: for any body and record, encoding then
	// refreshing the managed block leaves the body unchanged.
	it('prop_user_body_survives_refresh', () => {
		fc.assert(
			fc.property(fc.string(), fc.string({ minLength: 1 }), (body, newName) => {
				const record = fullRecord();
				const text = encodePointer(record, body);
				const refreshed = refreshManagedBlock(text, { ...record, originalName: newName });
				expect(decodePointer(refreshed).body).toBe(body);
			}),
			{ numRuns: 200 },
		);
	});

	// prop_frontmatter_roundtrip_arbitrary :: arbitrary scalar field values
	// (paths with colons, unicode, quotes) survive the YAML round-trip.
	it('prop_frontmatter_roundtrip_arbitrary', () => {
		fc.assert(
			fc.property(fc.string(), fc.string(), fc.string(), (name, path, content) => {
				const record: PointerRecord = {
					...fullRecord(),
					originalName: name,
					originalPath: path,
					contentType: content,
				};
				const decoded = decodePointer(encodePointer(record, USER_BODY));
				expect(decoded.record).toEqual(record);
			}),
			{ numRuns: 200 },
		);
	});
});

describe('pointer codec failure injection (la-p1-02)', () => {
	// A pointer whose managed block lost its end marker must raise, never silently
	// treat the rest of the file as body (which would let a half-written file
	// swallow the user's notes).
	it('fault_missing_end_marker_raises', () => {
		const text = encodePointer(fullRecord(), USER_BODY).replace(MANAGED_END, '');
		expect(() => decodePointer(text)).toThrow(PointerParseError);
	});

	// Two managed blocks (e.g. a botched merge) are ambiguous; raise rather than
	// guess which one is authoritative.
	it('fault_duplicate_managed_block_raises', () => {
		const text = encodePointer(fullRecord(), USER_BODY);
		const dupe = text + '\n' + MANAGED_START + '\nextra\n' + MANAGED_END + '\n';
		expect(() => decodePointer(dupe)).toThrow(PointerParseError);
	});

	// A file with no frontmatter is not a pointer; raise a typed error, never
	// return a partial record.
	it('fault_frontmatter_absent_raises', () => {
		expect(() => decodePointer('just a normal note with no frontmatter\n')).toThrow(PointerParseError);
	});

	// Frontmatter present but missing a required field is malformed; raise.
	it('fault_missing_required_field_raises', () => {
		const text = encodePointer(fullRecord(), USER_BODY).replace(/^la_bucket:.*$/m, '');
		expect(() => decodePointer(text)).toThrow(PointerParseError);
	});

	// An out-of-range verification tier would mislead the hard-delete gate; raise.
	it('fault_invalid_verification_tier_raises', () => {
		const text = encodePointer(fullRecord(), USER_BODY).replace(/^la_verification_tier:.*$/m, 'la_verification_tier: bogus');
		expect(() => decodePointer(text)).toThrow(PointerParseError);
	});
});
