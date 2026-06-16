import { S3AddressingStyle } from './credentials';

// Pure S3 request-shaping and response-classification. No `obsidian` import, so it
// is unit-testable. The actual network call lives in s3-connection.ts.

export interface S3ConnectionConfig {
	endpoint: string;
	region: string;
	bucket: string;
	addressingStyle: S3AddressingStyle;
}

export interface ConnectionTestResult {
	ok: boolean;
	detail: string;
}

// Builds the ListObjectsV2 URL for the bucket. Listing the bucket is the cheapest
// request that exercises the full credential + endpoint + region + bucket path:
// a 200 proves all four, and an error code says which one is wrong.
export function buildListUrl(config: S3ConnectionConfig): string {
	const endpoint = config.endpoint.replace(/\/+$/, '');
	const query = 'list-type=2&max-keys=1';
	if (config.addressingStyle === 'path') {
		return `${endpoint}/${config.bucket}?${query}`;
	}
	const url = new URL(endpoint);
	url.host = `${config.bucket}.${url.host}`;
	return `${url.origin}/?${query}`;
}

// Turns the HTTP status + S3 error body into a human verdict. S3 returns errors as
// XML with a <Code> element; the code is far more useful than the bare status.
export function classifyListResult(status: number, bodyText: string, bucket: string): ConnectionTestResult {
	if (status === 200) {
		const count = (bodyText.match(/<Key>/g) ?? []).length;
		return { ok: true, detail: `Connected. Bucket "${bucket}" is reachable (${count} object(s) on the first page).` };
	}
	const code = (/<Code>([^<]+)<\/Code>/.exec(bodyText) ?? [])[1] ?? '';
	return { ok: false, detail: `HTTP ${status}${code ? ` (${code})` : ''}. ${interpret(status, code)}` };
}

function interpret(status: number, code: string): string {
	if (code === 'SignatureDoesNotMatch') {
		return 'The secret access key is likely wrong.';
	}
	if (code === 'InvalidAccessKeyId') {
		return 'The access key ID is not recognized.';
	}
	if (code === 'AccessDenied') {
		return 'The key lacks permission to list this bucket, or the bucket or region is wrong.';
	}
	if (code === 'NoSuchBucket') {
		return 'There is no bucket by that name at this endpoint.';
	}
	if (code === 'PermanentRedirect' || code === 'AuthorizationHeaderMalformed' || status === 301) {
		return 'Wrong region or addressing style for this bucket.';
	}
	if (status === 403) {
		return 'Authentication failed: check the keys, bucket, and region.';
	}
	if (status === 404) {
		return 'Not found: check the endpoint, bucket name, and addressing style.';
	}
	if (status === 400) {
		return 'Bad request: check the region and addressing style.';
	}
	return 'Unexpected response; check the endpoint and configuration.';
}
