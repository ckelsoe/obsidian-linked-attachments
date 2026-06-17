import { S3Backend, S3Request, S3Transport, S3TransportResponse } from './s3-backend';
import { S3Credentials } from '../../credentials';
import { S3ConnectionConfig } from '../../s3-url';
import { ObjectNotFoundError } from './backend';
import { sha256Base64, sha256Hex } from '../hash/sha256';
import { OBJECT_METADATA_KEYS } from '../manifest/manifest';

// GATED live integration test (spec tier-2). Runs ONLY via `npm run
// test:integration` with R2 credentials in the environment (.env locally, or CI
// secrets). It is excluded from the default `npm test`. Everything it touches is
// confined to R2_TEST_PREFIX and cleaned up. Secrets are read from env and never
// logged.

const env = process.env;
const hasCreds =
	typeof env.R2_ENDPOINT === 'string' &&
	env.R2_ENDPOINT.length > 0 &&
	typeof env.R2_ACCESS_KEY_ID === 'string' &&
	env.R2_ACCESS_KEY_ID.length > 0 &&
	typeof env.R2_SECRET_ACCESS_KEY === 'string' &&
	env.R2_SECRET_ACCESS_KEY.length > 0;

// A node-fetch transport. fetch has no CORS in node, so it reaches R2 directly
// (production uses Obsidian's requestUrl for the same reason on the desktop).
const fetchTransport: S3Transport = async (request: S3Request): Promise<S3TransportResponse> => {
	const response = await fetch(request.url, {
		method: request.method,
		headers: request.headers,
		body: request.body,
	});
	const bytes = new Uint8Array(await response.arrayBuffer());
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});
	return { status: response.status, headers, bytes };
};

function buildConfig(): S3ConnectionConfig {
	// The endpoint may include a path (e.g. .../s3-dev-test); normalize to origin so
	// path-style addressing adds the bucket exactly once.
	const origin = new URL(env.R2_ENDPOINT ?? '').origin;
	return {
		endpoint: origin,
		region: env.R2_REGION !== undefined && env.R2_REGION.length > 0 ? env.R2_REGION : 'auto',
		bucket: env.R2_BUCKET ?? '',
		addressingStyle: env.R2_ADDRESSING === 'virtual-hosted' ? 'virtual-hosted' : 'path',
	};
}

function credentials(): S3Credentials {
	return { accessKeyId: env.R2_ACCESS_KEY_ID ?? '', secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '' };
}

const describeLive = hasCreds ? describe : describe.skip;

describeLive('S3Backend live round-trip on R2 (la-p3-11, gated)', () => {
	const prefix = env.R2_TEST_PREFIX !== undefined && env.R2_TEST_PREFIX.length > 0 ? env.R2_TEST_PREFIX : 'linked-attachments-livetest/';
	const key = `${prefix}roundtrip-${Date.now()}.bin`;
	const payload = new TextEncoder().encode(`linked-attachments live test payload ${Date.now()} ${'x'.repeat(64)}`);
	let backend: S3Backend;

	beforeAll(() => {
		backend = new S3Backend({ config: buildConfig(), getCredentials: credentials, transport: fetchTransport });
	});

	afterAll(async () => {
		// Best-effort cleanup so the bucket never accumulates test objects.
		try {
			await backend.delete(key);
		} catch {
			// ignore; the delete test usually already removed it
		}
	});

	it('PUT stores a checksummed object with metadata', async () => {
		const result = await backend.put(key, payload, payload.length, {
			checksumSha256: await sha256Base64(payload),
			contentType: 'application/octet-stream',
			metadata: { [OBJECT_METADATA_KEYS.sha256]: await sha256Hex(payload), [OBJECT_METADATA_KEYS.originalPath]: 'livetest/roundtrip.bin' },
		});
		expect(result.etag.length).toBeGreaterThan(0);
	});

	it('HEAD reports the size and the server checksum matches the local sha256', async () => {
		const head = await backend.head(key);
		expect(head.size).toBe(payload.length);
		expect(head.checksumSha256).toBe(await sha256Base64(payload));
		expect(head.metadata?.[OBJECT_METADATA_KEYS.originalPath]).toBe('livetest/roundtrip.bin');
	});

	it('GET returns the exact bytes', async () => {
		const got = await backend.get(key);
		expect(got.status).toBe(200);
		expect(new Uint8Array(await got.arrayBuffer())).toEqual(payload);
	});

	it('range GET returns 206 and only the requested bytes', async () => {
		const got = await backend.get(key, { start: 0, end: 7 });
		expect(got.status).toBe(206);
		expect(new Uint8Array(await got.arrayBuffer())).toEqual(payload.slice(0, 8));
	});

	it('LIST finds the object under the prefix', async () => {
		const page = await backend.list(prefix, { maxKeys: 1000 });
		expect(page.entries.some((entry) => entry.key === key)).toBe(true);
	});

	it('DELETE removes the object', async () => {
		await backend.delete(key);
		await expect(backend.head(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
	});
});
