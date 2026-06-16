# Linked Attachments

[![CI](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-linked-attachments/ci.yml?branch=main&label=CI&logo=github)](https://github.com/ckelsoe/obsidian-linked-attachments/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/actions/workflow/status/ckelsoe/obsidian-linked-attachments/release.yml?label=Release&logo=github)](https://github.com/ckelsoe/obsidian-linked-attachments/actions/workflows/release.yml) [![GitHub Downloads](https://img.shields.io/github/downloads/ckelsoe/obsidian-linked-attachments/total?logo=github&label=Downloads)](https://github.com/ckelsoe/obsidian-linked-attachments/releases) [![GitHub Stars](https://img.shields.io/github/stars/ckelsoe/obsidian-linked-attachments?style=flat&logo=github&label=Stars)](https://github.com/ckelsoe/obsidian-linked-attachments) [![Obsidian](https://img.shields.io/badge/Obsidian-v1.5.0%2B-7C3AED?logo=obsidian&logoColor=white)](https://obsidian.md) [![License](https://img.shields.io/github/license/ckelsoe/obsidian-linked-attachments)](https://github.com/ckelsoe/obsidian-linked-attachments/blob/main/LICENSE) [![Latest Release](https://img.shields.io/github/v/release/ckelsoe/obsidian-linked-attachments?label=Latest)](https://github.com/ckelsoe/obsidian-linked-attachments/releases/latest)

Offload large, cold files to your own S3-compatible bucket and keep a resolvable pointer note in your vault.

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
