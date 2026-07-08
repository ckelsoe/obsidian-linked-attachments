# Privacy Policy

_Last updated: 2026-07-08_

This policy explains what the **Linked Attachments** Obsidian plugin ("the plugin") does and does not do with your data. It applies to the plugin as distributed through the Obsidian Community Plugins marketplace, GitHub releases, and BRAT.

## Summary

The plugin collects no analytics and sends nothing to the maintainer or any third party. Depending on the storage mode you choose, it writes to a local folder you pick, to an S3-compatible bucket you configure with credentials you supply, or to both. Those credentials are held in your device's secret storage, never in plain text. In local-only mode the plugin makes no network requests at all.

## What the plugin does

The plugin moves large files out of your vault into storage you own and configure, leaving a small pointer note in the vault. That storage is a local folder you pick (such as a synced OneDrive, Dropbox, or NAS path), an S3-compatible bucket you configure, or both. It reads files you select for offload, writes their bytes to that storage, and can retrieve them again on demand. All of this happens only when you explicitly invoke an action. When an S3 mode is used the plugin never contacts a server other than the storage endpoint you enter; in local-only mode it makes no network requests.

## Data collection

- **No personal data is collected by the maintainer.** The plugin does not collect names, email addresses, file contents, usage statistics, or any other information for the maintainer or any third party.
- **No telemetry or analytics.** There is no tracking, crash reporting, or phone-home behavior of any kind.
- **No automatic background activity.** The plugin acts only when you explicitly invoke a command or trigger a documented event.

## Data storage

- **Credentials.** Your S3 access key and secret key are stored only in Obsidian's per-vault secret storage on your own device. They are never written to `data.json` and never travel through Obsidian Sync.
- **Settings.** Non-secret configuration (endpoint, region, bucket name, addressing style, and the names that reference your stored secrets) is saved by Obsidian in your vault's local `data.json` file, on your own device.
- **Your files.** File contents you choose to offload are written to the local folder you pick, uploaded to the S3-compatible bucket you configure, or both, depending on the storage mode. That folder and bucket are under your control, not the maintainer's. The plugin keeps a pointer note in your vault describing each offloaded file.

## Network use

When an S3 storage mode is used, the plugin makes network requests **only to the S3-compatible endpoint you configure**, to upload, retrieve, list, verify, or delete your own objects. It contacts no other server: not the maintainer's, not Obsidian's, not any analytics or third-party service. In local-only mode the plugin makes no network requests; it only reads and writes the local folder you choose.

## Third parties

The plugin shares no data with the maintainer or any analytics provider. Your files stay in the local folder you pick or go only to the storage provider you choose to configure, and any credentials go only to that provider, governed by its own terms and privacy policy. A local folder that you sync with a service such as OneDrive or Dropbox is then also governed by that service's terms.

## Disclaimer of liability

The plugin is provided free of charge, "AS IS", without warranty of any kind, as set out in the [MIT License](./LICENSE). To the maximum extent permitted by law, the maintainer is not liable for any loss, damage, or claim arising from use of the plugin.

## Information you choose to share

If you open a GitHub issue, discussion, or pull request, anything you paste there (file contents, screenshots, vault structure, system details) becomes **public**. The maintainer does not request this information and is not responsible for content you choose to post. Review and redact anything sensitive before submitting. To report a security vulnerability privately instead, see [SECURITY.md](./SECURITY.md).

## Changes to this policy

This policy may be updated as the plugin evolves. Material changes will be noted in [CHANGELOG.md](./CHANGELOG.md). The "last updated" date above reflects the current version.

## Contact

Questions about this policy: open an issue at [github.com/ckelsoe/obsidian-linked-attachments/issues](https://github.com/ckelsoe/obsidian-linked-attachments/issues). Do not use a public issue for security vulnerabilities; see [SECURITY.md](./SECURITY.md) for the private reporting channel.
