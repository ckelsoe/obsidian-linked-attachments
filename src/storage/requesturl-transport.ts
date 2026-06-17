import { requestUrl } from 'obsidian';
import { S3Request, S3Transport, S3TransportResponse } from './s3-backend';

// The production transport for S3Backend: Obsidian's requestUrl, which bypasses
// browser CORS on the desktop. throw:false so non-2xx responses are returned for
// the backend to classify rather than thrown. This is the only transport that
// imports `obsidian`; the backend itself stays runtime-agnostic and testable.
export const requestUrlTransport: S3Transport = async (request: S3Request): Promise<S3TransportResponse> => {
	const response = await requestUrl({
		url: request.url,
		method: request.method,
		headers: request.headers,
		body: request.body,
		throw: false,
	});
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(response.headers ?? {})) {
		headers[name.toLowerCase()] = value;
	}
	return { status: response.status, headers, bytes: new Uint8Array(response.arrayBuffer) };
};
