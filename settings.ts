import { S3AddressingStyle } from './credentials';

// Non-secret plugin configuration, persisted to data.json by Obsidian. The raw
// access key and secret key are NOT here; only the secretStorage IDs that
// reference them (accessKeyIdSecretName / secretAccessKeySecretName).
export interface LinkedAttachmentsSettings {
	endpoint: string;
	region: string;
	bucket: string;
	addressingStyle: S3AddressingStyle;
	accessKeyIdSecretName: string;
	secretAccessKeySecretName: string;
}

export const DEFAULT_SETTINGS: LinkedAttachmentsSettings = {
	endpoint: '',
	region: '',
	bucket: '',
	// Virtual-hosted is what AWS S3 and Cloudflare R2 use; path style is for MinIO
	// and some self-hosted setups. Default to the common case.
	addressingStyle: 'virtual-hosted',
	// Empty until the user creates a secret through the SecretComponent. The
	// component owns ID assignment; an empty name reads back as "no credential".
	accessKeyIdSecretName: '',
	secretAccessKeySecretName: '',
};
