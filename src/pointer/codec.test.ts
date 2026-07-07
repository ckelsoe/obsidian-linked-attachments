import fc from 'fast-check';
import {
	LA_VERSION,
	PointerRecord,
	PointerParseError,
	encodePointer,
	decodePointer,
	extractExtension,
	refreshManagedBlock,
	requireS3Backend,
} from './codec';
import { CALLOUT_HEADER, MANAGED_END, MANAGED_START } from './managed-block';

// The frontmatter region (both fences) of an encoded pointer, with the block and
// body sliced off. Used to assemble legacy comment-delimited notes for the
// migration and fault tests, since encode now only emits the callout format.
function frontmatterPrefix(): string {
	const encoded = encodePointer(fullRecord(), '');
	return encoded.slice(0, encoded.indexOf(CALLOUT_HEADER));
}

// A pointer note in the legacy HTML-comment-delimited format (single-newline body
// separator), the shape pre-migration notes still carry on disk.
function legacyNote(body: string): string {
	return `${frontmatterPrefix()}${MANAGED_START}\n[Open x](obsidian://linked-attachments?op=open&id=la-x)\n${MANAGED_END}\n${body}`;
}

// Tier 0: pure string/record codec. No backend, no network, no shared fixtures.

// A fully-populated record exercising every section-5 field, including the
// nullable ones set to non-null so the round-trip covers them.
function fullRecord(): PointerRecord {
	return {
		laVersion: LA_VERSION,
		id: '01J9Z0K3QECRANFIELD',
		hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
		backends: [
			{
				type: 's3',
				bucket: 's3-dev-test',
				key: 'charles-main/31-books/Romans/Cranfield--9f86d0.pdf',
				keyKind: 'hash',
			},
		],
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
			backends: [
				{
					type: 's3',
					bucket: 's3-dev-test',
					key: 'charles-main/31-books/Romans/Cranfield--9f86d0.pdf',
					keyKind: 'external',
				},
			],
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

	// AC3 :: the managed block regenerates in place; bytes outside it (frontmatter
	// values and the user body) are untouched. The block carries no filename now, so
	// what varies it is the backend set: refreshing with an added local backend adds
	// the local row while leaving the body byte-identical.
	it('test_managed_block_regen', () => {
		const record = fullRecord(); // S3-only
		const text = encodePointer(record, USER_BODY);
		const paired: PointerRecord = {
			...record,
			backends: [...record.backends, { type: 'local', path: 'books/x.pdf' }],
		};
		const refreshed = refreshManagedBlock(text, paired);
		expect(refreshed).toContain('> - Local: [open](');
		expect(decodePointer(refreshed).body).toBe(USER_BODY);
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

	// AC7 :: Obsidian's Properties UI rewrites frontmatter - it unquotes a timestamp
	// (which js-yaml's default schema then parses as a Date) and renders null as an
	// empty value. The codec must still decode such a pointer (spec section 10:
	// validate the envelope, tolerate sloppy values).
	it('test_tolerates_obsidian_reformatted_frontmatter', () => {
		const reformatted = [
			'---',
			'la_version: 1',
			'la_id: la-x',
			'la_hash: c0f0c5',
			'la_bucket: s3-dev-test',
			'la_key: e/x--c0f0c5.epub',
			'la_key_kind: hash',
			'la_original_name: x.epub',
			'la_original_ext: epub',
			'la_original_path: e/x.epub',
			'la_byte_size: 421804',
			'la_content_type: application/epub+zip',
			'la_copy_state: offloaded',
			'la_verification_tier: content',
			'la_remote_checksum: wPDFHeKaWod6m/5lhXNlwkS/fGZLZ2S54AwAXvk0xvI=',
			'la_checksum_algo: sha256',
			'la_part_size:',
			'la_part_count:',
			'la_offloaded_at: 2026-06-17T19:59:42.633Z', // UNQUOTED -> js-yaml Date
			'la_source_version:',
			'la_supersedes:',
			'---',
			'<!-- la:managed:start -->',
			'[Open x](obsidian://x)',
			'<!-- la:managed:end -->',
			'',
		].join('\n');
		const decoded = decodePointer(reformatted);
		expect(decoded.record.offloadedAt).toBe('2026-06-17T19:59:42.633Z');
		expect(decoded.record.partSize).toBeNull();
		expect(requireS3Backend(decoded.record).key).toBe('e/x--c0f0c5.epub');
		expect(decoded.record.hash).toBe('c0f0c5');
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

describe('pointer codec backends schema (la-p1-02)', () => {
	// A v1 pointer (flat la_bucket/la_key/la_key_kind, no la_backends) decodes into a
	// single synthesized S3 backend, and the legacy flat keys are consumed rather than
	// leaked into extraFrontmatter (so a re-encode does not duplicate them).
	it('test_v1_legacy_decode_synthesizes_s3_backend', () => {
		const v1 = [
			'---',
			'la_version: 1',
			'la_id: la-legacy',
			'la_hash: c0f0c5',
			'la_bucket: s3-dev-test',
			'la_key: e/x--c0f0c5.epub',
			'la_key_kind: hash',
			'la_original_name: x.epub',
			'la_original_ext: epub',
			'la_original_path: e/x.epub',
			'la_byte_size: 421804',
			'la_content_type: application/epub+zip',
			'la_copy_state: offloaded',
			'la_verification_tier: content',
			'la_remote_checksum:',
			'la_checksum_algo:',
			'la_part_size:',
			'la_part_count:',
			'la_offloaded_at: "2026-06-17T19:59:42.633Z"',
			'la_source_version:',
			'la_supersedes:',
			'---',
			MANAGED_START,
			'[Open x](obsidian://x)',
			MANAGED_END,
			'legacy body\n',
		].join('\n');
		const decoded = decodePointer(v1);
		expect(decoded.record.backends).toEqual([
			{ type: 's3', bucket: 's3-dev-test', key: 'e/x--c0f0c5.epub', keyKind: 'hash' },
		]);
		expect(decoded.extraFrontmatter).not.toHaveProperty('la_bucket');
		expect(decoded.extraFrontmatter).not.toHaveProperty('la_key');
		expect(decoded.extraFrontmatter).not.toHaveProperty('la_key_kind');
	});

	// A paired object (an S3 backend and a local backend) round-trips through the
	// la_backends list with both entries preserved in read-preference order.
	it('test_paired_backends_roundtrip', () => {
		const record: PointerRecord = {
			...fullRecord(),
			backends: [
				{ type: 's3', bucket: 's3-dev-test', key: 'e/x--c0f0c5.epub', keyKind: 'hash' },
				{ type: 'local', path: 'books/x.pdf' },
			],
		};
		const decoded = decodePointer(encodePointer(record, USER_BODY));
		expect(decoded.record.backends).toEqual([
			{ type: 's3', bucket: 's3-dev-test', key: 'e/x--c0f0c5.epub', keyKind: 'hash' },
			{ type: 'local', path: 'books/x.pdf' },
		]);
	});

	// encode writes the v2 la_backends list, never the v1 flat la_bucket/la_key keys.
	it('test_encode_writes_la_backends_not_flat', () => {
		const text = encodePointer(fullRecord(), USER_BODY);
		expect(text).toContain('la_backends');
		expect(text).not.toContain('la_bucket:');
		expect(text).not.toContain('la_key:');
	});

	// encode always stamps the current version, even when the in-memory record was
	// decoded from a v1 pointer, so a re-encoded pointer is never labelled v1 while
	// carrying the v2 la_backends shape.
	it('test_encode_stamps_current_version_even_from_v1_record', () => {
		const text = encodePointer({ ...fullRecord(), laVersion: 1 }, USER_BODY);
		expect(text).toContain('la_version: 2');
		expect(text).not.toContain('la_version: 1');
	});

	// The managed block shows a working action link for each backend the pointer
	// holds: open/reveal for a local copy, copy-reference for S3. A paired pointer
	// shows both; the links carry only the id (portable across machines).
	it('test_managed_block_shows_a_link_per_backend', () => {
		const record: PointerRecord = {
			...fullRecord(),
			backends: [
				{ type: 's3', bucket: 's3-dev-test', key: 'e/x--c0f0c5.epub', keyKind: 'hash' },
				{ type: 'local', path: 'books/x.pdf' },
			],
		};
		const text = encodePointer(record, USER_BODY);
		expect(text).toContain(`op=open&backend=local&id=${record.id}`);
		expect(text).toContain(`op=reveal&backend=local&id=${record.id}`);
		expect(text).toContain(`op=copy&backend=s3&id=${record.id}`);
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
	// A legacy pointer whose managed block lost its end marker must raise, never
	// silently treat the rest of the file as body (which would let a half-written
	// file swallow the user's notes).
	it('fault_missing_end_marker_raises', () => {
		const text = legacyNote(USER_BODY).replace(MANAGED_END, '');
		expect(() => decodePointer(text)).toThrow(PointerParseError);
	});

	// The block is anchored to the start of the region, so comment markers that
	// appear AGAIN lower in a legacy note's body are user content, not a second
	// managed block: they must survive decode, not trigger a false ambiguity error.
	it('preserves comment marker strings that reappear in a legacy body', () => {
		const body = 'notes\n<!-- la:managed:start -->\ninside\n<!-- la:managed:end -->\nmore\n';
		const decoded = decodePointer(legacyNote(body));
		expect(decoded.body).toBe(body);
	});

	// Valid frontmatter but neither a callout nor comment markers: the managed block
	// is missing, so decode raises rather than treating the trailing bytes as body.
	it('fault_no_managed_block_raises', () => {
		const text = frontmatterPrefix() + 'just a body, no managed block\n';
		expect(() => decodePointer(text)).toThrow(PointerParseError);
	});

	// A file with no frontmatter is not a pointer; raise a typed error, never
	// return a partial record.
	it('fault_frontmatter_absent_raises', () => {
		expect(() => decodePointer('just a normal note with no frontmatter\n')).toThrow(PointerParseError);
	});

	// Frontmatter present but missing a required field is malformed; raise.
	it('fault_missing_required_field_raises', () => {
		const text = encodePointer(fullRecord(), USER_BODY).replace(/^la_id:.*$/m, '');
		expect(() => decodePointer(text)).toThrow(PointerParseError);
	});

	// An out-of-range verification tier would mislead the hard-delete gate; raise.
	it('fault_invalid_verification_tier_raises', () => {
		const text = encodePointer(fullRecord(), USER_BODY).replace(/^la_verification_tier:.*$/m, 'la_verification_tier: bogus');
		expect(() => decodePointer(text)).toThrow(PointerParseError);
	});
});

describe('pointer codec callout separator round-trip (la-p1-02)', () => {
	// encode separates the callout from the body with a BLANK line so a callout,
	// which ends at the first non-`>` line, cannot swallow a body that itself starts
	// with `>`. Every body shape must survive encode -> decode byte-for-byte.
	const cases = [
		{ name: 'an empty body', body: '' },
		{ name: 'a normal body', body: USER_BODY },
		{ name: 'a body that starts with a blockquote line', body: '> quoted line\n> still quoted\n\nafter\n' },
		{ name: 'a body with leading blank lines', body: '\n\nleading blanks then text\n' },
	];
	it.each(cases)('round-trips $name byte-exact', ({ body }) => {
		const decoded = decodePointer(encodePointer(fullRecord(), body));
		expect(decoded.body).toBe(body);
		expect(decoded.record).toEqual(fullRecord());
	});

	// The blank-line separator specifically stops a blockquote body from merging into
	// the managed callout: the body decodes intact and identity still reads clean.
	it('does not merge a blockquote body into the managed callout', () => {
		const body = '> quoted line\n';
		const decoded = decodePointer(encodePointer(fullRecord(), body));
		expect(decoded.body).toBe(body);
		expect(decoded.record).toEqual(fullRecord());
	});
});

describe('pointer codec legacy migration (la-p1-02)', () => {
	// An old comment-delimited note refreshes into the callout format: the comment
	// markers are gone, the block is now a callout, and the user body is preserved
	// and separated from the callout by a blank line.
	it('migrates a legacy comment block to a callout, preserving the body', () => {
		const legacy = legacyNote('legacy body line\n');
		const migrated = refreshManagedBlock(legacy, fullRecord());
		expect(migrated).toContain(CALLOUT_HEADER);
		expect(migrated).not.toContain('<!-- la:managed');
		expect(migrated).toContain('\n\nlegacy body line\n');
		expect(decodePointer(migrated).body).toBe('legacy body line\n');
	});

	// A legacy note with an empty body migrates to a callout; the empty body still
	// decodes as empty (the `\n\n` join over an empty body is just a trailing blank
	// line, not body content).
	it('migrates a legacy note with an empty body', () => {
		const legacy = legacyNote('');
		const migrated = refreshManagedBlock(legacy, fullRecord());
		expect(migrated).toContain(CALLOUT_HEADER);
		expect(migrated).not.toContain('<!-- la:managed');
		expect(decodePointer(migrated).body).toBe('');
	});

	// A legacy note still decodes (identity read from frontmatter), and its body is
	// recovered across the single-newline legacy separator.
	it('decodes a legacy comment-delimited note', () => {
		const decoded = decodePointer(legacyNote('old body\n'));
		expect(decoded.body).toBe('old body\n');
		expect(decoded.record).toEqual(fullRecord());
	});
});

describe('pointer codec position-anchored block location (data-integrity)', () => {
	const BODY_WITH_MARKERS = 'before\n<!-- la:managed:start -->\nmiddle\n<!-- la:managed:end -->\nafter\n';
	const BODY_WITH_USER_CALLOUT = 'my notes\n\n> [!linked-attachments]- Storage\n> - my own note, not plugin-owned\n\ntail\n';

	// Finding 1: a valid callout note whose USER BODY contains the legacy comment
	// marker strings must round-trip the FULL body. Block location is anchored to the
	// start of the region, so body markers are never treated as the managed block.
	it('round-trips a callout note whose body contains the comment marker strings', () => {
		const decoded = decodePointer(encodePointer(fullRecord(), BODY_WITH_MARKERS));
		expect(decoded.body).toBe(BODY_WITH_MARKERS);
		expect(decoded.record).toEqual(fullRecord());
	});

	// Finding 1 (refresh side): refresh rewrites only the real block, never marker
	// strings sitting in the body.
	it('refresh leaves comment marker strings in the body untouched', () => {
		const text = encodePointer(fullRecord(), BODY_WITH_MARKERS);
		const refreshed = refreshManagedBlock(text, fullRecord());
		expect(decodePointer(refreshed).body).toBe(BODY_WITH_MARKERS);
	});

	// Finding 2: a user-authored `> [!linked-attachments]` callout further down in the
	// body is NOT the plugin block. Decode preserves it and refresh must not overwrite
	// it (the anchored, non-multiline regex only matches the block at position 0).
	it('does not treat a user-authored callout in the body as the managed block', () => {
		const text = encodePointer(fullRecord(), BODY_WITH_USER_CALLOUT);
		expect(decodePointer(text).body).toBe(BODY_WITH_USER_CALLOUT);
		const refreshed = refreshManagedBlock(text, fullRecord());
		expect(decodePointer(refreshed).body).toBe(BODY_WITH_USER_CALLOUT);
		expect(refreshed).toContain('> - my own note, not plugin-owned');
	});

	// Finding 3: a lone `\n` after a callout block is a malformed separator. It must
	// NOT be silently stripped (that would drop a byte and desync the round-trip); the
	// newline is preserved as the leading character of the body instead.
	it('does not silently strip a single-newline separator for the callout format', () => {
		const proper = encodePointer(fullRecord(), 'user body\n'); // callout\n\nuser body\n
		const malformed = proper.replace('\n\nuser body', '\nuser body');
		expect(decodePointer(malformed).body).toBe('\nuser body\n');
	});

	// The block continuation only consumes `> - ` rows, so a body line that itself
	// starts with `>` (a blockquote) is NOT swallowed into the callout even when a
	// hand-edit has collapsed the blank-line separator to a single newline. Without
	// this, the greedy `(?:\n>...)` form would eat the body's blockquote line.
	it('does not swallow a blockquote body line when the separator is malformed', () => {
		const proper = encodePointer(fullRecord(), '> body line\n'); // callout\n\n> body line\n
		const malformed = proper.replace('\n\n> body line', '\n> body line');
		expect(decodePointer(malformed).body).toBe('\n> body line\n');
	});
});
