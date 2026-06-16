// AWS Signature Version 4 request signer.
//
// This is the kept-seed artifact from the transport spike: the one genuinely hard,
// genuinely reusable piece. It is pure (no `obsidian` import) and uses Web Crypto
// (`crypto.subtle`), which is available both in Obsidian's Electron runtime and in
// Node 20+ for the unit tests, so it is testable against AWS known-answer vectors
// with no network.
//
// Scope note: canonical-URI encoding here assumes simple, already-safe path
// segments (bucket names, the list endpoint). Full object-key encoding is handled
// when the offload path lands; the connection test only lists a bucket.

const ALGORITHM = 'AWS4-HMAC-SHA256';
const encoder = new TextEncoder();

export interface SignInput {
	method: string;
	url: string;
	region: string;
	service: string;
	accessKeyId: string;
	secretAccessKey: string;
	// Extra headers to include in the signature (besides host/x-amz-date/
	// x-amz-content-sha256). Keys are lowercased and trimmed.
	headers?: Record<string, string>;
	// Request payload. Defaults to empty. The connection test sends no body.
	body?: string;
	// Test seam: fixed timestamp (YYYYMMDDTHHMMSSZ). Defaults to now.
	amzDate?: string;
}

export interface SignedRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
}

export async function signRequest(input: SignInput): Promise<SignedRequest> {
	const url = new URL(input.url);
	const amzDate = input.amzDate ?? currentAmzDate();
	const dateStamp = amzDate.slice(0, 8);
	const body = input.body ?? '';
	const payloadHash = await sha256Hex(body);

	// Assemble the headers that go into the signature. host, x-amz-content-sha256,
	// and x-amz-date are always signed; any extras are merged in lowercased.
	const headersToSign: Record<string, string> = {
		host: url.host,
		'x-amz-content-sha256': payloadHash,
		'x-amz-date': amzDate,
	};
	for (const [name, value] of Object.entries(input.headers ?? {})) {
		headersToSign[name.toLowerCase()] = value.trim();
	}

	const sortedNames = Object.keys(headersToSign).sort();
	const canonicalHeaders = sortedNames.map((n) => `${n}:${headersToSign[n] ?? ''}\n`).join('');
	const signedHeaders = sortedNames.join(';');

	const canonicalRequest = [
		input.method.toUpperCase(),
		canonicalUri(url.pathname),
		canonicalQueryString(url.searchParams),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join('\n');

	const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
	const stringToSign = [
		ALGORITHM,
		amzDate,
		credentialScope,
		await sha256Hex(canonicalRequest),
	].join('\n');

	const signingKey = await deriveSigningKey(input.secretAccessKey, dateStamp, input.region, input.service);
	const signature = toHex(await hmac(signingKey, stringToSign));

	const authorization =
		`${ALGORITHM} Credential=${input.accessKeyId}/${credentialScope}, ` +
		`SignedHeaders=${signedHeaders}, Signature=${signature}`;

	return {
		method: input.method.toUpperCase(),
		url: input.url,
		headers: { ...headersToSign, authorization },
	};
}

async function deriveSigningKey(secret: string, dateStamp: string, region: string, service: string): Promise<Uint8Array<ArrayBuffer>> {
	const kDate = await hmac(utf8(`AWS4${secret}`), dateStamp);
	const kRegion = await hmac(kDate, region);
	const kService = await hmac(kRegion, service);
	return hmac(kService, 'aws4_request');
}

// --- canonicalization helpers ------------------------------------------------

// AWS UriEncode: unreserved = A-Za-z0-9-_.~ ; everything else percent-encoded,
// uppercase hex. encodeURIComponent leaves !'()* unencoded, so finish those.
function encodeRfc3986(segment: string): string {
	return encodeURIComponent(segment).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function canonicalUri(pathname: string): string {
	if (pathname === '' || pathname === '/') {
		return '/';
	}
	return pathname.split('/').map(encodeRfc3986).join('/');
}

function canonicalQueryString(params: URLSearchParams): string {
	const pairs: Array<[string, string]> = [];
	for (const [key, value] of params.entries()) {
		pairs.push([encodeRfc3986(key), encodeRfc3986(value)]);
	}
	pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
	return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

// --- crypto helpers (Web Crypto) ---------------------------------------------

// Encodes a string to UTF-8 bytes backed by a fresh ArrayBuffer. TextEncoder
// returns Uint8Array<ArrayBufferLike>, which TS 5.8 will not accept as the
// ArrayBuffer-backed BufferSource that Web Crypto requires; copying into a freshly
// allocated Uint8Array fixes the type without a cast.
function utf8(input: string): Uint8Array<ArrayBuffer> {
	const source = encoder.encode(input);
	const out = new Uint8Array(source.byteLength);
	out.set(source);
	return out;
}

function toHex(bytes: Uint8Array): string {
	let hex = '';
	for (const b of bytes) {
		hex += b.toString(16).padStart(2, '0');
	}
	return hex;
}

async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', utf8(input));
	return toHex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
	const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, utf8(data)));
}

function currentAmzDate(): string {
	return new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
}
