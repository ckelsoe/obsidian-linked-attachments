import { parseMultipartUploads, buildListUploadsUrl, buildAbortUploadUrl, cleanupIncompleteUploads, MultipartTransport } from './multipart';

// Incomplete-multipart abort (spec section 4 / Path 10). A dropped multipart upload
// leaves invisible parts that keep costing money. This finds them (ListMultipartUploads)
// and aborts each (AbortMultipartUpload), stopping same-session billing. The URL
// building, XML parsing, and the cleanup loop are tier-0; the live S3 verification and
// the durable AbortIncompleteMultipartUpload lifecycle rule are parked (human/console).

const config = { endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: 'b', addressingStyle: 'path' as const };

describe('multipart URLs', () => {
	it('buildListUploadsUrl asks for ?uploads on the bucket', () => {
		expect(buildListUploadsUrl(config)).toBe('https://s3.us-east-1.amazonaws.com/b?uploads');
	});
	it('buildAbortUploadUrl targets the key with the upload id', () => {
		expect(buildAbortUploadUrl(config, 'books/a.pdf', 'abc123')).toBe('https://s3.us-east-1.amazonaws.com/b/books/a.pdf?uploadId=abc123');
	});
	it('buildAbortUploadUrl percent-encodes a key with spaces', () => {
		expect(buildAbortUploadUrl(config, 'a b.pdf', 'x')).toBe('https://s3.us-east-1.amazonaws.com/b/a%20b.pdf?uploadId=x');
	});
});

describe('parseMultipartUploads', () => {
	it('parses key, uploadId, and initiated per upload', () => {
		const xml =
			'<ListMultipartUploadsResult>' +
			'<Upload><Key>a.pdf</Key><UploadId>id-1</UploadId><Initiated>2026-06-17T00:00:00.000Z</Initiated></Upload>' +
			'<Upload><Key>b.pdf</Key><UploadId>id-2</UploadId></Upload>' +
			'</ListMultipartUploadsResult>';
		const uploads = parseMultipartUploads(xml);
		expect(uploads).toHaveLength(2);
		expect(uploads[0]).toEqual({ key: 'a.pdf', uploadId: 'id-1', initiated: '2026-06-17T00:00:00.000Z' });
		expect(uploads[1]).toEqual({ key: 'b.pdf', uploadId: 'id-2', initiated: null });
	});
	it('returns an empty array when there are no uploads', () => {
		expect(parseMultipartUploads('<ListMultipartUploadsResult></ListMultipartUploadsResult>')).toEqual([]);
	});
});

describe('cleanupIncompleteUploads', () => {
	const listXml =
		'<ListMultipartUploadsResult>' +
		'<Upload><Key>a.pdf</Key><UploadId>id-1</UploadId></Upload>' +
		'<Upload><Key>b.pdf</Key><UploadId>id-2</UploadId></Upload>' +
		'</ListMultipartUploadsResult>';

	it('aborts every incomplete upload it finds', async () => {
		const aborted: string[] = [];
		const transport: MultipartTransport = {
			list: () => Promise.resolve({ status: 200, text: listXml }),
			abort: (key, uploadId) => { aborted.push(`${key}:${uploadId}`); return Promise.resolve({ status: 204 }); },
		};
		const result = await cleanupIncompleteUploads(transport);
		expect(result).toEqual({ found: 2, aborted: 2, failed: 0 });
		expect(aborted).toEqual(['a.pdf:id-1', 'b.pdf:id-2']);
	});

	it('an abort failure is counted, the rest still run', async () => {
		const transport: MultipartTransport = {
			list: () => Promise.resolve({ status: 200, text: listXml }),
			abort: (key) => Promise.resolve({ status: key === 'a.pdf' ? 500 : 204 }),
		};
		const result = await cleanupIncompleteUploads(transport);
		expect(result).toEqual({ found: 2, aborted: 1, failed: 1 });
	});

	it('a clean bucket aborts nothing', async () => {
		const transport: MultipartTransport = {
			list: () => Promise.resolve({ status: 200, text: '<ListMultipartUploadsResult></ListMultipartUploadsResult>' }),
			abort: () => Promise.resolve({ status: 204 }),
		};
		expect(await cleanupIncompleteUploads(transport)).toEqual({ found: 0, aborted: 0, failed: 0 });
	});
});
