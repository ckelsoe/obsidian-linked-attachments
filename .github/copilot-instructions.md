# Copilot instructions for obsidian-linked-attachments

## What this repository is

Linked Attachments is an [Obsidian](https://obsidian.md) community plugin (TypeScript, esbuild bundle). It moves large files out of the vault into an S3-compatible bucket, a local folder outside the vault, or both. A Markdown pointer note replaces each file. The manifest sets `isDesktopOnly: true`.

Key architecture facts:

- Storage goes through the `StorageBackend` interface in `src/storage/backend.ts`. Implementations: `s3-backend.ts`, `local-backend.ts`, and `memory-backend.ts` for tests.
- S3 requests are signed by `sigv4.ts` and sent through Obsidian's `requestUrl` (`src/storage/requesturl-transport.ts`). There is no AWS SDK.
- The offload flow lives in `src/offload/pipeline.ts`, with progress recorded in `src/offload/journal.ts`. `src/service/attachment-service.ts` wires it to the vault.
- Pointer frontmatter is plugin-owned, under the `la_*` namespace. `src/pointer/codec.ts` encodes and decodes it. The body is user-owned.
- The managed block between `MANAGED_START` and `MANAGED_END` (`src/pointer/managed-block.ts`) is regenerated. It is never the source of truth.
- Content identity is the SHA-256 hash (`la_hash`, `src/hash/sha256.ts`). S3 objects also carry `x-amz-meta-*` recovery metadata.
- Credentials live in Obsidian's secret storage (`credentials.ts`). `data.json` holds only the secret names.

## Build, lint, test

```bash
npm run build          # tsc type-check + esbuild bundle
npm run lint           # eslint (zero warnings), prettier --check, submission pre-check, marketplace type-check
npm test               # Vitest unit tests
npm run knip           # unused files and exports
npm run type-coverage  # must stay at or above 99%
```

Build, lint and test must all pass. `npm run test:integration` runs live tests against a real bucket and needs a local `.env` (see `.env.example`). `npm run test:mutation` runs Stryker on demand.

## Hard rules

- Never `eslint-disable` an `obsidianmd/*` rule. Any other allowed disable carries a `-- reason`.
- No `as any`. No non-null assertions (`x!`); tests use `defined()` from `__tests__/helpers/checked.ts`.
- No regex lookbehind (`(?<=`, `(?<!`). It does not parse on older iOS JavaScriptCore.
- No bare `moment` from `obsidian`. Use `Date` or `Intl`.
- No `!important` in `styles.css`, no inline `style` attributes, no `innerHTML`/`outerHTML` writes, no `document.createElement`.
- Popout-safe DOM: use `activeDocument`/`activeWindow` or the element's own document, not a global captured once.
- Node built-ins are allowed (desktop only). Each Node member the code uses must be declared in `src/node-builtins.d.ts`, or the marketplace scan sees `any`.
- UI strings in sentence case. No "command" in command ids or names. Settings headings never contain "settings", "options", "general" or the plugin name.
- Validate every value read from `data.json` before use.
- Never store an access key or secret key value in settings. Store only the secret name.
- Vitest only (`vi.*`). Never remove, skip or weaken a test to make CI pass.
- README is public: no CI or release internals. No em dashes in prose or comments.

## Plugin-specific pitfalls

- Never lose a file. The vault original is removed only after `defaultCanRemoveOriginal` passes, which needs a `content` or `md5` verification tier. Do not loosen it.
- Never rewrite a note's reference to an object that was not confirmed written.
- A pointer must never end with zero valid backends. On a partial paired-mode failure, keep the source file.
- Old pointers must keep opening. `decodePointer` reads the legacy flat `la_bucket` / `la_key` shape; any schema change keeps that path and its tests.
- Pointer parsing fails loudly with `PointerParseError`. Never return a partial record or eat the user's body text.
- Object keys are assigned once at offload and never change. A vault rename updates the pointer only, never the stored object.
- Local keys use forward slashes and are relative to the machine's root. Convert to `path.sep` only at resolve time. Never store an absolute machine path in a pointer.
- The local root is per machine (`src/storage/local-root.ts`). Do not assume one path works on every computer.
- Reference scanning (`src/scan/references.ts`) ignores embeds inside fenced and inline code. Keep that when you change the scanner.
- A local file may exist but not be synced yet. Report "not synced", not "missing". In paired mode, fall back to S3.
