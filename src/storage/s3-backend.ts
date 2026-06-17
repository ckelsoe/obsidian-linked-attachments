import { signRequest } from '../../sigv4';
import { S3ConnectionConfig, buildObjectListUrl, objectUrl, parseCommonPrefixes, parseListContents, parseXmlTag } from '../../s3-url';
import { S3Credentials } from '../../credentials';
import { bodyToBytes, bytesToStream, toArrayBuffer } from './body';
import { sha256Hex } from '../hash/sha256';
import {
	BackendError,
	Capabilities,
	GetRange,
	GetResult,
	HeadResult,
	ListEntry,
	ListOptions,
	ListPage,
	ObjectNotFoundError,
	PutBody,
	PutOptions,
	PutResult,
	StorageBackend,
} from './backend';

// The production StorageBackend over the kept-seed SigV4 signer (spec 7.11). It
// is `obsidian`-free: the HTTP transport is injected, so the same class runs
// against Obsidian's requestUrl in production, a node fetch in the gated live
// test, and a fake in unit tests. Binary PUT is fully signed by passing the
// body's sha256 (the content identity) as the payload hash, and carries the
// disaster-recovery metadata + the x-amz-checksum-sha256 the server validates.

export interface S3Request {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: ArrayBuffer;
}

export interface S3TransportResponse {
	status: number;
	headers: Record<string, string>; // keys lowercased
	bytes: Uint8Array;
}

export type S3Transport = (request: S3Request) => Promise<S3TransportResponse>;

export interface S3BackendDeps {
	config: S3ConnectionConfig;
	getCredentials: () => S3Credentials | null;
	transport: S3Transport;
	capabilities?: Capabilities;
}

const META_PREFIX = 'x-amz-meta-';
const DEFAULT_CAPABILITIES: Capabilities = {
	upload: { presign: true, range: true, serverChecksum: true, conditionalWrite: true },
	access: 'presigned-url',
};
const AUTH_CODES = new Set(['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'TokenRefreshRequired']);

export class S3Backend implements StorageBackend {
	readonly capabilities: Capabilities;

	constructor(private readonly deps: S3BackendDeps) {
		this.capabilities = deps.capabilities ?? DEFAULT_CAPABILITIES;
	}

	async put(key: string, body: PutBody, size: number, opts: PutOptions = {}): Promise<PutResult> {
		const bytes = await bodyToBytes(body);
		const payloadHashHex = await sha256Hex(bytes);
		const headers: Record<string, string> = {};
		if (opts.checksumSha256 !== undefined) {
			headers['x-amz-checksum-sha256'] = opts.checksumSha256;
		}
		if (opts.contentType !== undefined && opts.contentType.length > 0) {
			headers['content-type'] = opts.contentType;
		}
		for (const [name, value] of Object.entries(opts.metadata ?? {})) {
			headers[`${META_PREFIX}${name}`] = value;
		}
		const response = await this.send('PUT', objectUrl(this.deps.config, key), { headers, body: toArrayBuffer(bytes), payloadHashHex });
		if (!isOk(response.status)) {
			throw this.error(response, `put ${key}`);
		}
		return { etag: response.headers['etag'] ?? '', checksumSha256: response.headers['x-amz-checksum-sha256'] };
	}

	async head(key: string): Promise<HeadResult> {
		const response = await this.send('HEAD', objectUrl(this.deps.config, key), { headers: { 'x-amz-checksum-mode': 'ENABLED' } });
		if (response.status === 404) {
			throw new ObjectNotFoundError(key);
		}
		if (!isOk(response.status)) {
			throw this.error(response, `head ${key}`);
		}
		return {
			size: Number(response.headers['content-length'] ?? '0'),
			etag: response.headers['etag'] ?? '',
			checksumSha256: response.headers['x-amz-checksum-sha256'],
			lastModified: response.headers['last-modified'],
			metadata: collectMetadata(response.headers),
		};
	}

	async get(key: string, range?: GetRange): Promise<GetResult> {
		const headers: Record<string, string> = { 'x-amz-checksum-mode': 'ENABLED' };
		if (range !== undefined) {
			headers.range = `bytes=${range.start}-${range.end}`;
		}
		const response = await this.send('GET', objectUrl(this.deps.config, key), { headers });
		if (response.status === 404) {
			throw new ObjectNotFoundError(key);
		}
		if (!isOk(response.status)) {
			throw this.error(response, `get ${key}`);
		}
		const bytes = response.bytes;
		return {
			status: response.status,
			contentRange: response.headers['content-range'],
			checksumSha256: response.headers['x-amz-checksum-sha256'],
			stream(): ReadableStream<Uint8Array> {
				return bytesToStream(bytes);
			},
			arrayBuffer(): Promise<ArrayBuffer> {
				return Promise.resolve(toArrayBuffer(bytes));
			},
		};
	}

	async delete(key: string): Promise<void> {
		const response = await this.send('DELETE', objectUrl(this.deps.config, key), { headers: {} });
		// S3 DELETE is idempotent: a 204 or a 404 both mean "gone". Only auth /
		// other errors are real failures.
		if (response.status === 404 || isOk(response.status)) {
			return;
		}
		throw this.error(response, `delete ${key}`);
	}

	async list(prefix = '', opts: ListOptions = {}): Promise<ListPage> {
		let url = buildObjectListUrl(this.deps.config, prefix.length > 0 ? prefix : null, opts.maxKeys ?? 1000, opts.cursor ?? null);
		if (opts.delimiter !== undefined && opts.delimiter.length > 0) {
			url += `&delimiter=${encodeURIComponent(opts.delimiter)}`;
		}
		const response = await this.send('GET', url, { headers: {} });
		if (!isOk(response.status)) {
			throw this.error(response, `list ${prefix}`);
		}
		const xml = new TextDecoder().decode(response.bytes);
		const entries: ListEntry[] = parseListContents(xml).map((object) => ({
			key: object.key,
			size: object.size,
			etag: object.etag,
			lastModified: object.lastModified ?? undefined,
		}));
		const isTruncated = parseXmlTag(xml, 'IsTruncated') === 'true';
		const nextToken = parseXmlTag(xml, 'NextContinuationToken');
		return { entries, commonPrefixes: parseCommonPrefixes(xml), isTruncated, cursor: isTruncated ? nextToken : null };
	}

	displayKey(key: string): string {
		return key;
	}

	// --- internals --------------------------------------------------------------

	private async send(
		method: string,
		url: string,
		opts: { headers: Record<string, string>; body?: ArrayBuffer; payloadHashHex?: string },
	): Promise<S3TransportResponse> {
		const creds = this.deps.getCredentials();
		if (creds === null) {
			throw new BackendError('auth', 'credentials are not configured (no key in secret storage)');
		}
		const signed = await signRequest({
			method,
			url,
			region: this.deps.config.region.length > 0 ? this.deps.config.region : 'us-east-1',
			service: 's3',
			accessKeyId: creds.accessKeyId,
			secretAccessKey: creds.secretAccessKey,
			headers: opts.headers,
			payloadHashHex: opts.payloadHashHex,
		});
		// The HTTP client sets Host from the URL; it matches what we signed.
		const sent = { ...signed.headers };
		delete sent.host;
		return this.deps.transport({ method, url: signed.url, headers: sent, body: opts.body });
	}

	private error(response: S3TransportResponse, context: string): BackendError {
		const code = parseXmlTag(new TextDecoder().decode(response.bytes), 'Code');
		const authStatus = response.status === 401 || response.status === 403;
		if (authStatus || (code !== null && AUTH_CODES.has(code))) {
			return new BackendError('auth', `${context}: authentication/authorization failed (HTTP ${response.status}${code !== null ? ` ${code}` : ''})`);
		}
		return new BackendError('network', `${context}: HTTP ${response.status}${code !== null ? ` (${code})` : ''}`);
	}
}

function isOk(status: number): boolean {
	return status >= 200 && status < 300;
}

function collectMetadata(headers: Record<string, string>): Record<string, string> {
	const metadata: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (name.startsWith(META_PREFIX)) {
			metadata[name.slice(META_PREFIX.length)] = value;
		}
	}
	return metadata;
}
