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

// Resolves the request origin and the path prefix for the bucket. Path style keeps
// the bucket in the path (/bucket); virtual-hosted moves it into the host.
export function baseUrl(config: S3ConnectionConfig): { origin: string; pathPrefix: string } {
	const endpoint = config.endpoint.replace(/\/+$/, '');
	if (config.addressingStyle === 'path') {
		return { origin: endpoint, pathPrefix: `/${config.bucket}` };
	}
	const url = new URL(endpoint);
	url.host = `${config.bucket}.${url.host}`;
	return { origin: url.origin, pathPrefix: '' };
}

// Builds the ListObjectsV2 URL for the bucket. Listing is the cheapest request that
// exercises the full credential + endpoint + region + bucket path: a 200 proves all
// four, and an error code says which one is wrong.
export function buildListUrl(config: S3ConnectionConfig): string {
	return buildObjectListUrl(config, null, 1, null);
}

// URL for a single object key. Keys are split on '/' so each path segment is a
// segment in the URL; the signer applies the canonical encoding for the signature.
export function objectUrl(config: S3ConnectionConfig, key: string): string {
	const { origin, pathPrefix } = baseUrl(config);
	return `${origin}${pathPrefix}/${key}`;
}

// ListObjectsV2 URL with optional prefix, page size, and continuation token.
export function buildObjectListUrl(
	config: S3ConnectionConfig,
	prefix: string | null,
	maxKeys: number,
	continuationToken: string | null,
): string {
	const { origin, pathPrefix } = baseUrl(config);
	const params = new URLSearchParams();
	params.set('list-type', '2');
	params.set('max-keys', String(maxKeys));
	if (prefix !== null && prefix.length > 0) {
		params.set('prefix', prefix);
	}
	if (continuationToken !== null && continuationToken.length > 0) {
		params.set('continuation-token', continuationToken);
	}
	const path = pathPrefix.length > 0 ? pathPrefix : '/';
	return `${origin}${path}?${params.toString()}`;
}

// --- ListObjectsV2 XML parsing (regex; the responses are small and flat) -------

export function parseListedKeys(xml: string): string[] {
	const keys: string[] = [];
	const re = /<Key>([^<]+)<\/Key>/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(xml)) !== null) {
		const key = match[1];
		if (key !== undefined) {
			keys.push(key);
		}
	}
	return keys;
}

export function parseXmlTag(xml: string, tag: string): string | null {
	const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
	return match?.[1] ?? null;
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
