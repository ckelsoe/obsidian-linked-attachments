import { requestUrl } from 'obsidian';
import { signRequest } from './sigv4';
import { S3Credentials } from './credentials';
import { AuditSink } from './logger';
import { S3ConnectionConfig, ConnectionTestResult, buildListUrl, classifyListResult, describeNetworkFailure } from './s3-url';

// Signs and sends a ListObjectsV2 against the configured bucket to validate the
// whole connection (credentials + endpoint + region + bucket) in one request.
// Transport is Obsidian's requestUrl, which bypasses browser CORS on desktop.
// Every bucket op is recorded to the audit log (metadata only, never the keys).
export async function testConnection(config: S3ConnectionConfig, creds: S3Credentials, audit: AuditSink): Promise<ConnectionTestResult> {
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

	const startedAt = Date.now();
	try {
		const response = await requestUrl({ url: signed.url, method: 'GET', headers: sentHeaders, throw: false });
		audit.audit({
			op: 'list',
			method: 'GET',
			url: signed.url,
			status: response.status,
			bytes: response.text.length,
			durationMs: Date.now() - startedAt,
			outcome: response.status === 200 ? 'success' : 'error',
		});
		return classifyListResult(response.status, response.text, config.bucket);
	} catch {
		audit.audit({
			op: 'list',
			method: 'GET',
			url: signed.url,
			durationMs: Date.now() - startedAt,
			outcome: 'error',
			detail: 'network error or unreachable host',
		});
		return { ok: false, detail: describeNetworkFailure() };
	}
}
