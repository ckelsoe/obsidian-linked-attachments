import { requestUrl } from 'obsidian';
import { signRequest } from './sigv4';
import { S3Credentials } from './credentials';
import { AuditSink } from './logger';
import { S3ConnectionConfig, objectUrl, buildObjectListUrl, parseListedKeys, parseXmlTag } from './s3-url';

// Thin S3 verb layer over the SigV4 signer and Obsidian's requestUrl. Every call
// is recorded to the audit sink (metadata only). This is the transport the spike's
// remote probe exercises; the production StorageBackend graduates from the same
// signer + transport seam.

export interface S3Context {
	config: S3ConnectionConfig;
	creds: S3Credentials;
	audit: AuditSink;
}

export interface S3Response {
	status: number;
	headers: Record<string, string>;
	text: string;
}

export interface ListResult {
	status: number;
	keys: string[];
	isTruncated: boolean;
	nextToken: string | null;
}

interface SendOptions {
	headers?: Record<string, string>;
	body?: string;
}

async function send(ctx: S3Context, op: string, method: string, url: string, options: SendOptions): Promise<S3Response> {
	const startedAt = Date.now();
	const signed = await signRequest({
		method,
		url,
		region: ctx.config.region.length > 0 ? ctx.config.region : 'us-east-1',
		service: 's3',
		accessKeyId: ctx.creds.accessKeyId,
		secretAccessKey: ctx.creds.secretAccessKey,
		headers: options.headers,
		body: options.body,
	});

	const sentHeaders = { ...signed.headers };
	delete sentHeaders.host;

	try {
		const response = await requestUrl({ url: signed.url, method, headers: sentHeaders, body: options.body, throw: false });
		const text = response.text ?? '';
		ctx.audit.audit({
			op,
			method,
			url,
			status: response.status,
			bytes: text.length,
			durationMs: Date.now() - startedAt,
			outcome: response.status >= 200 && response.status < 300 ? 'success' : 'error',
		});
		return { status: response.status, headers: lowerKeys(response.headers ?? {}), text };
	} catch (error) {
		ctx.audit.audit({ op, method, url, durationMs: Date.now() - startedAt, outcome: 'error', detail: 'network error' });
		throw error;
	}
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		out[name.toLowerCase()] = value;
	}
	return out;
}

export function putObject(ctx: S3Context, key: string, body: string, checksumSha256Base64?: string): Promise<S3Response> {
	const headers: Record<string, string> = {};
	if (checksumSha256Base64 !== undefined) {
		headers['x-amz-checksum-sha256'] = checksumSha256Base64;
	}
	return send(ctx, 'put', 'PUT', objectUrl(ctx.config, key), { headers, body });
}

export function headObject(ctx: S3Context, key: string, checksumMode: boolean): Promise<S3Response> {
	const headers: Record<string, string> = {};
	if (checksumMode) {
		headers['x-amz-checksum-mode'] = 'ENABLED';
	}
	return send(ctx, 'head', 'HEAD', objectUrl(ctx.config, key), { headers });
}

export function getObject(ctx: S3Context, key: string, options: { range?: { start: number; end: number }; checksumMode?: boolean } = {}): Promise<S3Response> {
	const headers: Record<string, string> = {};
	if (options.range !== undefined) {
		headers['range'] = `bytes=${options.range.start}-${options.range.end}`;
	}
	if (options.checksumMode === true) {
		headers['x-amz-checksum-mode'] = 'ENABLED';
	}
	return send(ctx, 'get', 'GET', objectUrl(ctx.config, key), { headers });
}

export function deleteObject(ctx: S3Context, key: string): Promise<S3Response> {
	return send(ctx, 'delete', 'DELETE', objectUrl(ctx.config, key), {});
}

export async function listObjects(ctx: S3Context, prefix: string, maxKeys: number, continuationToken: string | null = null): Promise<ListResult> {
	const url = buildObjectListUrl(ctx.config, prefix, maxKeys, continuationToken);
	const response = await send(ctx, 'list', 'GET', url, {});
	return {
		status: response.status,
		keys: parseListedKeys(response.text),
		isTruncated: parseXmlTag(response.text, 'IsTruncated') === 'true',
		nextToken: parseXmlTag(response.text, 'NextContinuationToken'),
	};
}
