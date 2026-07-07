# Linked Attachments

[![CI](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-linked-attachments/ci.yml?branch=main&label=CI&logo=github)](https://github.com/ckelsoe/obsidian-linked-attachments/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-linked-attachments/release.yml?label=Release&logo=github)](https://github.com/ckelsoe/obsidian-linked-attachments/actions/workflows/release.yml) [![GitHub Downloads](https://img.shields.io/github/downloads/ckelsoe/obsidian-linked-attachments/total?logo=github&label=Downloads)](https://github.com/ckelsoe/obsidian-linked-attachments/releases) [![GitHub Stars](https://img.shields.io/github/stars/ckelsoe/obsidian-linked-attachments?style=flat&logo=github&label=Stars)](https://github.com/ckelsoe/obsidian-linked-attachments) [![Obsidian](https://img.shields.io/badge/Obsidian-v1.5.0%2B-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md) [![License](https://img.shields.io/github/license/ckelsoe/obsidian-linked-attachments)](https://github.com/ckelsoe/obsidian-linked-attachments/blob/main/LICENSE) [![Latest Release](https://img.shields.io/github/v/release/ckelsoe/obsidian-linked-attachments?label=Latest)](https://github.com/ckelsoe/obsidian-linked-attachments/releases/latest)

Offload large, cold files to your own S3-compatible bucket or a local folder, keeping a resolvable pointer note in your vault.

## Storage modes

Choose where offloaded files go in settings:

- **S3 only** — files go to your own S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze B2, Wasabi, MinIO, and others).
- **Local only** — files move to a folder outside the vault, such as a synced OneDrive, Dropbox, or NAS path. Reads are instant and no cloud account is required. Pick your provider and set the folder in settings.
- **Local and S3 (paired)** — files are written to both: the local copy is the fast read path and the S3 copy is a durable off-machine backup. Opens prefer the local copy and fall back to S3 if it is missing.

In every mode the original is only removed after the copy is verified byte-for-byte, and each offloaded file leaves a plain pointer note so you can always find and retrieve it. Use **Add a local mirror** or **Add an S3 mirror** to upgrade existing pointers from one mode to paired without re-offloading.

> This version is desktop-only, because writing to a local folder uses desktop file access that the mobile app does not provide.

## Local folders across machines

A synced vault opens on more than one machine, and the same synced folder is rarely at the same absolute path everywhere: a different drive letter on another Windows PC, a completely different location on macOS. Linked Attachments resolves the local folder per machine so one synced vault just works:

- The pointer note stores a portable, folder-relative key, never a machine-specific absolute path.
- Settings hold a root per operating system. Set the folder once on each OS you open the vault on. Within one OS the setting is portable across machines: a Windows OneDrive folder is stored in its `%OneDriveCommercial%` form, so it resolves correctly on any drive letter with no re-editing.
- The settings panel shows what the folder resolves to on the machine you are looking at, so you can confirm it before you trust a file.

Two things to know:

- **The plugin is required to open a local link.** A local attachment link resolves through the plugin. With the plugin disabled or uninstalled the link will not open, though the pointer note still reads as plain text and its frontmatter still records where the file lives, so nothing is lost.
- **The bytes have to have synced.** The folder can resolve correctly while your sync client (OneDrive, Dropbox, and so on) has not finished downloading the file, or the pointer note itself has not synced to this machine yet. In that case the link cannot open here yet. In paired mode the S3 copy is opened instead; in local-only mode you get a message that the copy has not synced, not an error implying the file is gone.

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

BRAT lets power users install pre-release builds before they reach the marketplace.

1. Install the **BRAT** plugin from Community Plugins.
2. Open BRAT settings and click **Add Beta Plugin**.
3. Enter: `https://github.com/ckelsoe/obsidian-linked-attachments`
4. Enable **Linked Attachments** in Settings → Community plugins.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, quality gates, and conventions.

## License

MIT. See [LICENSE](./LICENSE).
