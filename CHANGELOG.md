# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Reconcile with storage: a new command scans your pointer notes against what is actually in your bucket and groups the results into four plain-language outcomes - healthy, not yet linked, changed in the bucket, and missing object - with one safe action: link the unlinked objects into your vault. It only reads; it never deletes or overwrites anything in the bucket.

## [0.2.0] - 2026-06-17

### Added
- Trust badges everywhere it matters: an offload now reports the tier it reached (Verified / Found / Asserted) and whether the original was actually trashed, a "Check storage status" item on any pointer note shows its current trust badge, and the round-trip rehearsal is reachable from settings as well as the command palette.
- Adopt from bucket: a new "Adopt files from storage" command lists objects already in your bucket under an optional prefix, shows them by filename in a checklist (hiding ones you already track and flagging name collisions), and creates pointer notes for the ones you tick. The scan is list-only and never downloads anything; adopted files are marked catalogued, not yet byte-verified. A paste-a-key field adopts a single object directly.
- Batch offload: select several attachments in the file explorer and offload them in one go. A preview table lists every file, its size, and the total before anything moves; on confirm, each file is uploaded, verified, and trashed in turn with a live progress list, and one file failing never stops the rest.
- Embeds follow the file: when you offload an attachment, every note that embeds it is rewritten to transclude the pointer note instead, so the embed keeps working; restoring reverses it. Page anchors and captions are preserved, and embeds inside code blocks are left alone.

## [0.1.0] - 2026-06-17

### Added
- Round-trip rehearsal: a "Rehearse a round-trip on a test file" command exercises your bucket end to end on a throwaway object and shows each step pass in turn - uploaded, verified byte-for-byte, retrieved, and matches the original - so you can confirm your storage works before trusting it with a real file. The throwaway object is cleaned up automatically and nothing in your vault is touched.
- Offload preview: before a file is offloaded, a dry-run preview shows exactly where it will go - the destination bucket and key, the pointer note path, and the size - with nothing moved until you confirm. The preview is computed by the same logic that performs the offload, so what you see is what gets committed.
- Clearer connection-test failures: a clock-skew error now tells you to fix your device clock, and an unreachable endpoint names the likely causes in plain words (offline, wrong endpoint, or a blocked request) instead of a bare network error.
- Offload and restore from the desktop: an "Offload the active file to storage" command and a right-click "Offload to storage" on an attachment upload the file to your bucket, confirm the cloud copy, write a pointer note beside it, and move the original to trash. "Restore the active pointer note" downloads the object, checks the bytes against the recorded hash, writes the file back, and removes the pointer. The original is never removed unless its verified copy exists in the bucket.
- S3 storage backend: the real Cloudflare R2 / S3 implementation behind the storage interface, signing each request with the built-in SigV4 signer over an injectable HTTP transport. Uploads are fully signed binary transfers that carry a server-validated checksum and recovery metadata, and the listing parser reads object sizes and tags. Verified end to end against a live R2 bucket (upload, checksum confirm, download, range, list, delete).
- Reconciliation scan: compares your pointer notes against what is actually in the bucket and reports four states - healthy, pointer with a missing object, bucket object with no pointer, and content drift (the object changed underneath a pointer). It only ever reports and offers to link unlinked objects; it never deletes or overwrites anything in the bucket.
- Adopt from bucket: catalogue files that already live in your bucket by listing them under a prefix and creating pointer notes at mirrored vault paths, recognising files by name rather than raw keys. The scan is list-only and cheap (hundreds of objects in a single listing, no per-file downloads), skips anything that already has a pointer or would collide with an existing note, and marks adopted files as catalogued (not yet byte-verified). A paste-a-key option adopts a single object directly.
- Verify-before-delete safety gate: before any local file is removed, the plugin confirms the cloud copy by the strongest available method (a server-side checksum, an MD5 match, or downloading and re-hashing the bytes) and refuses to delete unless that confirmation meets a configurable bar. A drifted or missing object never authorizes a deletion.
- Offload engine: moves a file to the bucket in a strict safe order (upload, then confirm the cloud copy byte-for-byte, then write the pointer note, then remove the local original only after all of that succeeds). Any failure leaves your original file untouched, and a half-finished earlier attempt is re-checked rather than trusted, so a file is never deleted unless its verified copy exists in the bucket.
- Local text extraction for searchability: for text-bearing files (PDF, EPUB, DOCX, and similar) the plugin can keep a local copy of the document text so vault search still works after the file is offloaded. Scanned documents with no text layer are marked explicitly rather than left silently empty, so a search miss is never misleading.
- Manifest cache: a fast index of every offloaded object, rebuilt from the pointer notes (the source of truth) or, as a recovery path, from the bucket listing. The cached copy is always discardable: a corrupted manifest is rejected and rebuilt rather than trusted, and the pointer notes win any disagreement.
- Readable storage keys: an offloaded file is stored under a key that mirrors its vault path with a short content-hash suffix (for example `charles-main/books/Romans/Cranfield--9f86d0.pdf`), so the object is easy to find in any S3 browser. The key is fixed when the file is offloaded and never changes on a later rename; re-uploading different bytes creates a new versioned key rather than overwriting the old one.
- Reference scanner: finds note embeds that point at an attachment in either link form, rewrites them to target the pointer note on offload and back to the file on restore (preserving captions and page anchors), ignores embeds inside code blocks, and conservatively flags references it does not manage so an attachment is never deleted while something still points at it.
- Pointer note codec: read and write the machine fields in a pointer's frontmatter, regenerate the open link without touching the user's notes, and preserve any other frontmatter (such as tags) across edits. The pointer's identity is always read from frontmatter, never from the body, so the body is always safe to edit.
- StorageBackend interface and an in-memory MemoryBackend (the tier-0 test stand-in): typed put/get/head/delete/list verbs, two-axis capability flags, server-side checksum validation on upload, and a content-addressed sha256 helper. The seam every offload and reconciliation module is built against.
- Plugin scaffold from the workspace standard template (CI, release, lint, and scorecard tooling).
- Secure credential storage: S3 access key and secret key are held in Obsidian's per-vault secret storage via `SecretComponent`, never in `data.json`. Non-secret connection config (endpoint, region, bucket, addressing style) and the secret-name references live in settings.
- Settings tab with a connection group and a credentials group, plus a secret-storage check that round-trips a value to confirm the API works on the current platform (AC-G6, desktop).
