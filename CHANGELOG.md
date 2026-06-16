# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- StorageBackend interface and an in-memory MemoryBackend (the tier-0 test stand-in): typed put/get/head/delete/list verbs, two-axis capability flags, server-side checksum validation on upload, and a content-addressed sha256 helper. The seam every offload and reconciliation module is built against.
- Plugin scaffold from the workspace standard template (CI, release, lint, and scorecard tooling).
- Secure credential storage: S3 access key and secret key are held in Obsidian's per-vault secret storage via `SecretComponent`, never in `data.json`. Non-secret connection config (endpoint, region, bucket, addressing style) and the secret-name references live in settings.
- Settings tab with a connection group and a credentials group, plus a secret-storage check that round-trips a value to confirm the API works on the current platform (AC-G6, desktop).
