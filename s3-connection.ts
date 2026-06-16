import { requestUrl } from 'obsidian';
import { signRequest } from './sigv4';
import { S3Credentials } from './credentials';
import { S3ConnectionConfig, ConnectionTestResult, buildListUrl, classifyListResult } from './s3-url';

// Signs and sends a ListObjectsV2 against the configured bucket to validate the
// whole connection (credentials + endpoint + region + bucket) in one request.
// Transport is Obsidian's requestUrl, which bypasses browser CORS on desktop.
export async function testConnection(config: S3ConnectionConfig, creds: S3Credentials): Promise<ConnectionTestResult> {
	let url: string;
	try {
		url = buildListUrl(config);
	} catch {
		return { ok: false, detail: 'The endpoint is not a valid URL.' };
	}

	const signed = await signRequest({
		method: 'GET',
		url,
		region: config.region.length > 0 ? config.region : 'us-east-1',
		service: 's3',
		accessKeyId: creds.accessKeyId,
		secretAccessKey: creds.secretAccessKey,
	});

	// The HTTP client sets the Host header from the URL, and it matches what we
	// signed, so do not send our own host header (some clients reject a manual one).
	const sentHeaders = { ...signed.headers };
	delete sentHeaders.host;

	try {
		const response = await requestUrl({ url: signed.url, method: 'GET', headers: sentHeaders, throw: false });
		return classifyListResult(response.status, response.text, config.bucket);
	} catch {
		return { ok: false, detail: 'Could not reach the endpoint (network error or unreachable host).' };
	}
}
