# Linked Attachments

[![CI](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-linked-attachments/ci.yml?branch=main&label=CI&logo=github)](https://github.com/ckelsoe/obsidian-linked-attachments/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-linked-attachments/release.yml?label=Release&logo=github)](https://github.com/ckelsoe/obsidian-linked-attachments/actions/workflows/release.yml) [![GitHub Downloads](https://img.shields.io/github/downloads/ckelsoe/obsidian-linked-attachments/total?logo=github&label=Downloads)](https://github.com/ckelsoe/obsidian-linked-attachments/releases) [![GitHub Stars](https://img.shields.io/github/stars/ckelsoe/obsidian-linked-attachments?style=flat&logo=github&label=Stars)](https://github.com/ckelsoe/obsidian-linked-attachments) [![Obsidian](https://img.shields.io/badge/Obsidian-v1.13.0%2B-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md) [![License](https://img.shields.io/github/license/ckelsoe/obsidian-linked-attachments)](https://github.com/ckelsoe/obsidian-linked-attachments/blob/main/LICENSE) [![Latest Release](https://img.shields.io/github/v/release/ckelsoe/obsidian-linked-attachments?label=Latest)](https://github.com/ckelsoe/obsidian-linked-attachments/releases/latest)

Offload large, cold files to your own S3-compatible bucket or a local folder, keeping a resolvable pointer note in your vault.

## What it does

Big binaries (PDFs, audio, video, archives) bloat a vault and slow every sync. Linked Attachments moves the ones you pick out of the vault into storage you control, and leaves a small pointer note in their place. The pointer note records where the file lives, so you can open it, reveal it, or pull it back into the vault on demand.

The original is only removed after the copy is verified byte-for-byte, so an offload never loses a file. Each pointer note is plain, readable Markdown: even with the plugin uninstalled, its frontmatter still records the bucket, key, and path, so a file is always recoverable.

## Why this plugin?

You want a heavy file out of your vault (so it stops syncing everywhere and slowing indexing) but still findable and openable from the note that referenced it. Copying files out by hand loses that link and the recovery trail. Linked Attachments keeps the link as a pointer note, verifies every move, and can keep a second copy for durability, so getting files out of the vault is safe and reversible instead of a one-way manual chore.

## Storage modes

Choose where offloaded files go in settings:

- **S3 only**: files go to your own S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze B2, Wasabi, MinIO, and others).
- **Local only**: files move to a folder outside the vault, such as a synced OneDrive, Dropbox, or NAS path. Reads are instant and no cloud account is required.
- **Local and S3 (paired)**: files are written to both. The local copy is the fast read path and the S3 copy is a durable off-machine backup. Opens prefer the local copy and fall back to S3 if it is missing.

> This version is desktop-only, because writing to a local folder uses desktop file access that the mobile app does not provide.

## Quick start

1. Open **Settings → Linked Attachments** and pick a **Storage mode**.
2. Configure that mode: for S3, set the endpoint, region, bucket, and link your access key and secret key; for a local folder, click **Add this machine** and **Browse** to the offload folder. Use **Test connection** or **Rehearse a round-trip** to confirm the setup before you trust a real file.
3. **Right-click a file** in the file explorer and choose **Offload to storage** (or run the command **Offload the active file to storage**). The file is uploaded, verified, and replaced by a pointer note.
4. To use an offloaded file, **right-click its pointer note**: **Open in default app**, **Reveal local copy in file explorer**, or **Restore from storage** to bring the real file back into the vault.

## Features

- **Offload**: one file from the right-click menu or the command palette, a whole-vault sweep by file type, or automatic offload of new large files as they arrive.
- **Open and retrieve**: open a pointer in its default app, reveal the local copy, copy a storage reference, or restore the file back into the vault.
- **Keep copies in sync**: add a local or S3 mirror to existing pointers (from the command palette or the **Backfill existing pointers** settings buttons), and adopt files that already exist in storage.
- **Health checks**: check backend integrity (every pointer still has its file), reconcile the vault against storage, resume an interrupted offload, and view an activity log.
- **Edit an offloaded file**: check out a pointer to edit its file, then check in a new version or discard the checkout.

## Local folders across machines

A vault used on more than one computer rarely has its synced folder at the same absolute path everywhere: a different drive letter on another Windows PC, a completely different location on macOS. Linked Attachments sets the local folder per machine so the vault opens correctly on each:

- The pointer note stores a portable, folder-relative key, never a machine-specific absolute path.
- Settings hold a list of machines, one row per computer (its name and its offload folder). On each machine, click **Add this machine** and **Browse** to the folder. If you sync your settings across machines, every machine adds its own row and reads its own folder, so even two Windows machines with different drive letters both resolve correctly. You can rename a row if a computer is renamed or re-imaged.
- A banner shows what the folder resolves to on the machine you are looking at, so you can confirm it before you trust a file.

Two things to know:

- **The plugin is required to open a local link.** A local attachment link resolves through the plugin. With the plugin disabled or uninstalled the link will not open, though the pointer note still reads as plain text and its frontmatter still records where the file lives, so nothing is lost.
- **The bytes have to have synced.** The folder can resolve correctly while your sync client (OneDrive, Dropbox, and so on) has not finished downloading the file, or the pointer note itself has not synced to this machine yet. In that case the link cannot open here yet. In paired mode the S3 copy is opened instead; in local-only mode you get a message that the copy has not synced, not an error implying the file is gone.

## Settings

- **Storage**: the storage mode, and the per-machine local folder list.
- **Connection** (S3 modes): endpoint, region, bucket, and addressing style, with a **Test connection** button.
- **Credentials** (S3 modes): link an access key and secret key. Only the secret names are saved; the values stay in your device's secret storage.
- **Backfill existing pointers**: one button per active backend to copy missing files into existing pointers after a mode change.
- **Round-trip rehearsal**: verify a full upload, verify, and retrieve on a throwaway object before you trust a real file.
- **File type rules**: choose which file types offload, always or over a size threshold, and scan the whole vault against those rules.
- **Automatic offload**: optionally offload qualifying new files as they are added, on prompt or after an idle delay.
- **Diagnostics**: debug logging and an activity-log viewer.

## Installation

### From Obsidian Community Plugins (recommended)

1. Open Obsidian settings.
2. Navigate to **Community plugins**.
3. Click **Browse**.
4. Search for **Linked Attachments**.
5. Click **Install**, then **Enable**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/ckelsoe/obsidian-linked-attachments/releases/latest).
2. Create a folder named `linked-attachments` in your vault's `.obsidian/plugins/` directory.
3. Copy the downloaded files into this folder.
4. Reload Obsidian.
5. Enable **Linked Attachments** in Settings → Community plugins.

### BRAT (optional, for pre-release testing)

BRAT lets power users install pre-release builds before they reach the marketplace. Regular users should install from Community Plugins instead.

1. Install the **BRAT** plugin from Community Plugins.
2. Open BRAT settings and click **Add Beta Plugin**.
3. Enter `https://github.com/ckelsoe/obsidian-linked-attachments`.
4. Enable **Linked Attachments** in Settings → Community plugins.

## Privacy

The plugin collects no analytics and phones home to no one. It talks only to the S3-compatible endpoint you configure and writes only to the local folder you choose. Your access key and secret key live in your device's secret storage, never in `data.json` and never through Obsidian Sync. See [PRIVACY.md](./PRIVACY.md) for the full policy.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, quality gates, and conventions.

## Support

Questions and bug reports: open an issue at [github.com/ckelsoe/obsidian-linked-attachments/issues](https://github.com/ckelsoe/obsidian-linked-attachments/issues). For security vulnerabilities, use the private channel in [SECURITY.md](./SECURITY.md) instead.

## License

MIT. See [LICENSE](./LICENSE).
