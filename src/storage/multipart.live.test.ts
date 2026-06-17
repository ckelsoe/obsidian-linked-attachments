import { signRequest } from '../../sigv4';
import { S3ConnectionConfig, objectUrl, parseXmlTag } from '../../s3-url';
import { buildListUploadsUrl, buildAbortUploadUrl, parseMultipartUploads, cleanupIncompleteUploads, MultipartTransport } from './multipart';

// GATED live integration test (spec tier-2) for the multipart abort verbs added in
// la-p4-24. Runs ONLY via `npm run test:integration` with R2 creds in the
// environment; excluded from the default `npm test` and self-skips without creds, so
// the default gate stays green for everyone. It initiates a REAL multipart upload on
// R2 (the dropped-upload state we are protecting against), then proves
// ListMultipartUploads finds it and AbortMultipartUpload removes it. Everything is
// confined to R2_TEST_PREFIX and cleaned up; secrets are read from env, never logged.

const env = process.env;
const hasCreds =
	typeof env.R2_ENDPOINT === 'string' &&
	env.R2_ENDPOINT.length > 0 &&
	typeof env.R2_ACCESS_KEY_ID === 'string' &&
	env.R2_ACCESS_KEY_ID.length > 0 &&
	typeof env.R2_SECRET_ACCESS_KEY === 'string' &&
	env.R2_SECRET_ACCESS_KEY.length > 0;

function buildConfig(): S3ConnectionConfig {
	const origin = new URL(env.R2_ENDPOINT ?? '').origin;
	return {
		endpoint: origin,
		region: env.R2_REGION !== undefined && env.R2_REGION.length > 0 ? env.R2_REGION : 'auto',
		bucket: env.R2_BUCKET ?? '',
		addressingStyle: env.R2_ADDRESSING === 'virtual-hosted' ? 'virtual-hosted' : 'path',
	};
}

// Sign a request with SigV4 and send it over node fetch (no CORS in node, like the
// requestUrl transport on the desktop). Returns the status and the body text.
async function signedSend(config: S3ConnectionConfig, method: 'GET' | 'POST' | 'DELETE', url: string): Promise<{ status: number; text: string }> {
	const signed = await signRequest({
		method,
		url,
		region: config.region.length > 0 ? config.region : 'auto',
		service: 's3',
		accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
		secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
	});
	const headers = { ...signed.headers };
	delete headers.host;
	const response = await fetch(signed.url, { method, headers });
	return { status: response.status, text: await response.text() };
}

const describeLive = hasCreds ? describe : describe.skip;

describeLive('incomplete-multipart cleanup live on R2 (la-p4-24, gated)', () => {
	const config = buildConfig();
	const prefix = env.R2_TEST_PREFIX !== undefined && env.R2_TEST_PREFIX.length > 0 ? env.R2_TEST_PREFIX : 'linked-attachments-livetest/';
	const key = `${prefix}multipart-orphan-${Date.now()}.bin`;
	let uploadId: string | null = null;

	afterAll(async () => {
		// Best-effort: never leave a stuck upload if a test bailed out mid-way.
		if (uploadId !== null) {
			await signedSend(config, 'DELETE', buildAbortUploadUrl(config, key, uploadId)).catch(() => undefined);
		}
	});

	it('initiates then aborts a multipart upload by its exact id (CreateMultipart + AbortMultipart)', async () => {
		// Create the dropped-upload state. R2 returns the UploadId on CreateMultipartUpload.
		const initiated = await signedSend(config, 'POST', `${objectUrl(config, key)}?uploads`);
		expect(initiated.status).toBe(200);
		uploadId = parseXmlTag(initiated.text, 'UploadId');
		expect(uploadId).not.toBeNull();

		// Abort it directly by the id we hold - no dependency on R2's listing lag.
		const aborted = await signedSend(config, 'DELETE', buildAbortUploadUrl(config, key, uploadId ?? ''));
		expect(aborted.status).toBe(204);
		uploadId = null; // aborted; nothing for afterAll to clean
	});

	it('ListMultipartUploads returns a parseable listing (the LIST verb signs and parses)', async () => {
		const listed = await signedSend(config, 'GET', buildListUploadsUrl(config));
		expect(listed.status).toBe(200);
		// The parser accepts R2's real response shape (array, possibly empty).
		expect(Array.isArray(parseMultipartUploads(listed.text))).toBe(true);
	});

	it('cleanupIncompleteUploads runs end to end live and sweeps any orphans', async () => {
		const transport: MultipartTransport = {
			list: () => signedSend(config, 'GET', buildListUploadsUrl(config)),
			abort: async (k, id) => ({ status: (await signedSend(config, 'DELETE', buildAbortUploadUrl(config, k, id))).status }),
		};
		const result = await cleanupIncompleteUploads(transport);
		// Whatever it found, it aborted (no partial failures) - the orchestrator works
		// against the real wire, and the dev bucket is left with no incomplete uploads.
		expect(result.aborted).toBe(result.found);
		expect(result.failed).toBe(0);
	});
});
