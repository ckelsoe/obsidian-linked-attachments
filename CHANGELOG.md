# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
