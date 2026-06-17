import { S3ConnectionConfig, baseUrl, objectUrl, parseXmlTag } from '../../s3-url';

// Incomplete-multipart abort (spec section 4, data-loss/cost Path 10). A dropped
// multipart upload leaves parts that keep accruing storage cost and are invisible in
// a normal listing. This module builds the ListMultipartUploads / AbortMultipartUpload
// requests, parses the listing, and runs the cleanup loop - all tier-0 over an
// injected transport. The actual signed network calls and the durable
// AbortIncompleteMultipartUpload lifecycle rule (the backstop that works even if the
// plugin never runs) are wired/handled outside and verified live.

export interface MultipartUpload {
	key: string;
	uploadId: string;
	initiated: string | null;
}

export function buildListUploadsUrl(config: S3ConnectionConfig): string {
	const { origin, pathPrefix } = baseUrl(config);
	const path = pathPrefix.length > 0 ? pathPrefix : '';
	return `${origin}${path}?uploads`;
}

export function buildAbortUploadUrl(config: S3ConnectionConfig, key: string, uploadId: string): string {
	return `${objectUrl(config, key)}?uploadId=${uploadId}`;
}

export function parseMultipartUploads(xml: string): MultipartUpload[] {
	const uploads: MultipartUpload[] = [];
	const re = /<Upload>([\s\S]*?)<\/Upload>/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(xml)) !== null) {
		const block = match[1] ?? '';
		const key = parseXmlTag(block, 'Key');
		const uploadId = parseXmlTag(block, 'UploadId');
		if (key === null || uploadId === null) {
			continue;
		}
		uploads.push({ key, uploadId, initiated: parseXmlTag(block, 'Initiated') });
	}
	return uploads;
}

export interface MultipartTransport {
	list(): Promise<{ status: number; text: string }>;
	abort(key: string, uploadId: string): Promise<{ status: number }>;
}

export interface CleanupResult {
	found: number;
	aborted: number;
	failed: number;
}

export async function cleanupIncompleteUploads(transport: MultipartTransport): Promise<CleanupResult> {
	const listed = await transport.list();
	const uploads = parseMultipartUploads(listed.text);
	let aborted = 0;
	let failed = 0;
	for (const upload of uploads) {
		const result = await transport.abort(upload.key, upload.uploadId);
		// A 204 (or any 2xx) is a successful abort; DELETE on a missing upload is also fine.
		if (result.status >= 200 && result.status < 300) {
			aborted++;
		} else {
			failed++;
		}
	}
	return { found: uploads.length, aborted, failed };
}
