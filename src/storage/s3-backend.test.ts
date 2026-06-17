import { S3Backend, S3Request, S3TransportResponse, S3Transport } from './s3-backend';
import { S3ConnectionConfig } from '../../s3-url';
import { BackendError, ObjectNotFoundError } from './backend';
import { sha256Base64, sha256Hex } from '../hash/sha256';
import { OBJECT_METADATA_KEYS } from '../manifest/manifest';

// Tier 0: S3Backend against an injected fake transport. Proves the request it
// builds (URL, signed headers, metadata, checksum, payload hash) and how it maps
// responses - no network, no Obsidian.

const config: S3ConnectionConfig = {
	endpoint: 'https://acct.r2.cloudflarestorage.com',
	region: 'auto',
	bucket: 's3-dev-test',
	addressingStyle: 'path',
};

const creds = () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'shhh-secret' });

function harness(responder: (request: S3Request) => S3TransportResponse): { backend: S3Backend; requests: S3Request[] } {
	const requests: S3Request[] = [];
	const transport: S3Transport = (request) => {
		requests.push(request);
		return Promise.resolve(responder(request));
	};
	return { backend: new S3Backend({ config, getCredentials: creds, transport }), requests };
}

function res(status: number, headers: Record<string, string> = {}, bytes: Uint8Array = new Uint8Array()): S3TransportResponse {
	return { status, headers, bytes };
}

function text(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

describe('S3Backend request construction (la-p3-11)', () => {
	it('put signs the binary payload and sends checksum + metadata + content-type', async () => {
		const body = text('the document bytes');
		const { backend, requests } = harness(() => res(200, { etag: '"abc"', 'x-amz-checksum-sha256': 'CKSUM' }));
		const result = await backend.put('books/x--9f.pdf', body, body.length, {
			checksumSha256: await sha256Base64(body),
			contentType: 'application/pdf',
			metadata: { [OBJECT_METADATA_KEYS.sha256]: 'deadbeef', [OBJECT_METADATA_KEYS.originalPath]: 'books/x.pdf' },
		});
		const sent = requests[0];
		expect(sent?.method).toBe('PUT');
		expect(sent?.url).toBe('https://acct.r2.cloudflarestorage.com/s3-dev-test/books/x--9f.pdf');
		// the binary payload is signed: x-amz-content-sha256 == sha256(body)
		expect(sent?.headers['x-amz-content-sha256']).toBe(await sha256Hex(body));
		expect(sent?.headers['x-amz-checksum-sha256']).toBe(await sha256Base64(body));
		expect(sent?.headers['content-type']).toBe('application/pdf');
		expect(sent?.headers['x-amz-meta-sha256']).toBe('deadbeef');
		expect(sent?.headers['x-amz-meta-originalpath']).toBe('books/x.pdf');
		expect(sent?.headers.authorization).toContain('AWS4-HMAC-SHA256');
		expect(result.etag).toBe('"abc"');
		expect(result.checksumSha256).toBe('CKSUM');
	});

	it('head maps content-length, etag, checksum, lastModified, and metadata', async () => {
		const { backend } = harness(() =>
			res(200, {
				'content-length': '2048',
				etag: '"e"',
				'x-amz-checksum-sha256': 'CK',
				'last-modified': 'Tue, 16 Jun 2026 12:00:00 GMT',
				'x-amz-meta-sha256': 'abc',
			}),
		);
		const head = await backend.head('k');
		expect(head.size).toBe(2048);
		expect(head.etag).toBe('"e"');
		expect(head.checksumSha256).toBe('CK');
		expect(head.lastModified).toBe('Tue, 16 Jun 2026 12:00:00 GMT');
		expect(head.metadata?.sha256).toBe('abc');
	});

	it('head raises ObjectNotFoundError on 404', async () => {
		const { backend } = harness(() => res(404));
		await expect(backend.head('missing')).rejects.toBeInstanceOf(ObjectNotFoundError);
	});

	it('get returns the bytes and a 206 content-range on a range request', async () => {
		const body = text('0123456789');
		const { backend, requests } = harness(() => res(206, { 'content-range': 'bytes 2-5/10' }, text('2345')));
		const got = await backend.get('k', { start: 2, end: 5 });
		expect(got.status).toBe(206);
		expect(got.contentRange).toBe('bytes 2-5/10');
		expect(new Uint8Array(await got.arrayBuffer())).toEqual(text('2345'));
		expect(requests[0]?.headers.range).toBe('bytes=2-5');
		expect(body.length).toBe(10);
	});

	it('get raises ObjectNotFoundError on 404', async () => {
		const { backend } = harness(() => res(404));
		await expect(backend.get('missing')).rejects.toBeInstanceOf(ObjectNotFoundError);
	});

	it('delete is idempotent: 204 and 404 both succeed', async () => {
		const ok = harness(() => res(204));
		await expect(ok.backend.delete('k')).resolves.toBeUndefined();
		const gone = harness(() => res(404));
		await expect(gone.backend.delete('k')).resolves.toBeUndefined();
	});

	it('list parses entries, common prefixes, and the continuation cursor', async () => {
		const xml =
			'<ListBucketResult><IsTruncated>true</IsTruncated>' +
			'<Contents><Key>p/a.pdf</Key><Size>10</Size><ETag>&quot;e1&quot;</ETag></Contents>' +
			'<Contents><Key>p/b.pdf</Key><Size>20</Size><ETag>&quot;e2&quot;</ETag></Contents>' +
			'<NextContinuationToken>tok==</NextContinuationToken></ListBucketResult>';
		const { backend, requests } = harness(() => res(200, {}, text(xml)));
		const page = await backend.list('p/', { maxKeys: 2 });
		expect(page.entries.map((e) => e.key)).toEqual(['p/a.pdf', 'p/b.pdf']);
		expect(page.entries[0]?.size).toBe(10);
		expect(page.isTruncated).toBe(true);
		expect(page.cursor).toBe('tok==');
		expect(requests[0]?.url).toContain('list-type=2');
	});
});

describe('S3Backend error handling (la-p3-11)', () => {
	it('refuses to call the transport when credentials are missing', async () => {
		const requests: S3Request[] = [];
		const backend = new S3Backend({
			config,
			getCredentials: () => null,
			transport: (request) => {
				requests.push(request);
				return Promise.resolve(res(200));
			},
		});
		await expect(backend.head('k')).rejects.toMatchObject({ kind: 'auth' });
		expect(requests).toHaveLength(0);
	});

	it('classifies a 403 AccessDenied as an auth error', async () => {
		const xml = '<Error><Code>AccessDenied</Code></Error>';
		const { backend } = harness(() => res(403, {}, text(xml)));
		await expect(backend.put('k', text('x'), 1)).rejects.toMatchObject({ kind: 'auth' });
	});

	it('classifies a 500 as a network error', async () => {
		const { backend } = harness(() => res(500, {}, text('<Error><Code>InternalError</Code></Error>')));
		await expect(backend.list('p/')).rejects.toMatchObject({ kind: 'network' });
	});

	it('exposes both capability axes and a passthrough display key', () => {
		const { backend } = harness(() => res(200));
		expect(backend.capabilities.upload.serverChecksum).toBe(true);
		expect(backend.capabilities.access).toBe('presigned-url');
		expect(backend.displayKey('folder/x--9f.pdf')).toBe('folder/x--9f.pdf');
	});

	it('surfaces a typed BackendError for a non-auth failure', async () => {
		const { backend } = harness(() => res(503, {}, new Uint8Array()));
		await expect(backend.head('k')).rejects.toBeInstanceOf(BackendError);
	});
});
