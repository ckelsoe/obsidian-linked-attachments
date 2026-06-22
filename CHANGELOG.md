# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Per-file-type offload rules and a whole-vault scan. A new "File type rules" settings section lets you list each file type and say how it offloads: "always" (offloaded at any size, for example every epub) or "offload when larger than" its own size in MB (for example PDFs over 5 MB but not small ones). Each type carries its own threshold, and you add or remove types freely. A type that is not listed is never offloaded. The "Scan the whole vault now" button applies these rules to every file already in your vault and offloads the matches in one batch, with the same preview of every file and the total before anything moves, and the same per-file verify-before-trash. The command palette has a matching "Scan vault and offload by file type" action.

### Changed
- Automatic offload now reads the same per-type rules, so a file caught automatically when added is exactly a file the vault scan would catch, and the other way round. The old single list of types plus one global size threshold is replaced by the per-type rules. Your existing settings migrate automatically on upgrade: each type you had listed becomes an "offload when larger than" rule carrying your old threshold, so nothing you already offloaded changes. Switch any type to "always" when you want it offloaded regardless of size.

## [2.0.0] - 2026-06-18

### Added
- Check out and check in offloaded files (desktop): edit a non-markdown offloaded file in its native app and save it back as a new version, without an S3 drive-mapping tool. Check out downloads the object, confirms its bytes, writes an editable working copy to a sync-excluded folder, and opens it in your default app; the pointer note stays in place as the visible record and shows a status. Check in re-hashes the working copy and, if it changed, uploads a new content-addressed version and confirms it before the pointer advances, keeping every earlier version (never an overwrite). Discard drops the working copy without uploading.
- Advisory cross-device lock: when a file is checked out, the pointer note records which device holds it, so another device sees "checked out on <device>" and defaults to leaving it alone, with a force option for a stale checkout. There is no server, so this is advisory, not enforced, and the plugin says so.
- Conflict safety: if the cloud version changed while you had a file checked out, checking in keeps both versions (last write becomes current, the other is preserved as a recognizable conflict copy). It never tries to merge.
- A status-bar indicator shows the active pointer's state: up to date (green), checked out with the cloud copy untouched (orange), or checked out with local edits not yet saved to the cloud (red). New commands and right-click items: check out, check in, and discard checkout.

## [1.2.0] - 2026-06-18

### Added
- Automatic offload on add (opt-in, off by default): when you add a new file of an allowed type that is larger than a size threshold, the plugin offers to offload it so the heavy bytes never try to sync across your devices. By default it prompts you with a one-click "offload it" notice and never moves anything on its own. An opt-in "offload when idle" mode (desktop only) offloads a qualifying file after it has been untouched for a set number of minutes; mobile always prompts and never sweeps in the background. Checked-out working copies are skipped, and every auto-offload runs the same duplicate check as a manual offload. New settings: enable toggle, file types, size threshold, trigger mode, and idle window.

## [1.1.0] - 2026-06-18

### Added
- No accidental duplicate objects: when you offload a file whose exact bytes are already in your bucket (for example the same document under a new name or path), the plugin now links a new pointer note to the existing object instead of uploading a second copy. It still confirms the existing object really holds those bytes before removing your local original, and it tells you "already in storage; linked here". One object can be referenced by several pointer notes. If the existing object cannot be confirmed (it drifted or is missing), the plugin uploads a fresh copy as before, so your file is always safely offloaded either way.

## [1.0.3] - 2026-06-18

### Fixed
- Restore now puts the file back next to its pointer note's current location. Before, if you renamed or moved the folder a pointer lived in, restoring recreated the old folder and put the file there, leaving the moved folder empty. Restore now follows the pointer wherever it is (including moves synced from another device) and uses the recorded original filename.

## [1.0.2] - 2026-06-18

### Fixed
- The offload preview dialog was unreadable: the fields were forced into two columns so labels and values collided and the destination key wrapped one character per line. It now stacks each field cleanly (label above, full-width value below), and the batch preview shows a proper file/size list with a separated total.

## [1.0.1] - 2026-06-17

### Added
- Open on mobile: a "Copy storage reference" action on any pointer note copies the file's name, honest size and format, and the exact bucket and key, so you can open the object in your own S3 app on a phone (where the plugin does not transfer files itself). It works on desktop too for pasting into an S3 browser.

## [1.0.0] - 2026-06-17

### Added
- Clean up incomplete uploads: the reconcile view can now find and abort dropped multipart uploads in your bucket, which otherwise sit there invisibly accruing storage cost. (A one-time bucket lifecycle rule is still the recommended durable backstop.)
- Honest auth errors: when an offload or restore fails because your storage keys are stale on this device, you now get a plain "re-enter them in settings; nothing was changed" message instead of a raw 403, and the failure is told apart from an ordinary network error.
- Crash-safe batch offload: each batch now writes a small session journal that records every file's progress and is deleted when the batch finishes. If Obsidian or your machine dies mid-batch, the journal survives, and a new "Resume an interrupted offload" command finishes the files that did not complete (re-checking anything already uploaded rather than trusting it). A corrupted journal is discarded, never acted on.
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
