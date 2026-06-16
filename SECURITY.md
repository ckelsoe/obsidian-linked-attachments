# Security Policy

## Supported Versions

Only the latest published version of Linked Attachments receives security updates.

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| older   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in Linked Attachments, please report it **privately** so it can be fixed before public disclosure:

1. **DO NOT** open a public GitHub issue for security vulnerabilities.
2. Open the repository's **Security** tab and click **Report a vulnerability**, or use this direct link: <https://github.com/ckelsoe/obsidian-linked-attachments/security/advisories/new>
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

Reports submitted through GitHub private vulnerability reporting are visible only to you and the maintainer until an advisory is published.

### What to expect:

- Acknowledgment within 48 hours
- Assessment and response within 7 days
- Security patch released as soon as possible
- Credit given to reporter (unless you prefer to remain anonymous)

## Security Considerations

- **Credentials at rest.** Your S3 access key and secret key are stored only in Obsidian's per-vault secret storage on your device. They are never written to `data.json`, never logged, and never travel through Obsidian Sync.
- **Network scope.** The plugin makes requests only to the S3-compatible endpoint you configure. It contacts no other server.
- **Least privilege.** Use an access key scoped to only the bucket you offload into, with just the object operations the plugin needs (put, get, head, list, delete). Do not reuse an account-wide or admin key.
- **File access.** The plugin reads the files you select for offload and writes pointer notes into your vault. It does not read or transmit anything you do not act on explicitly.
