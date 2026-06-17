import { buildListUrl, classifyListResult, objectUrl, buildObjectListUrl, parseListedKeys, parseXmlTag, parseListContents, parseCommonPrefixes, describeNetworkFailure } from '../s3-url';

describe('parseListContents', () => {
	const xml =
		'<ListBucketResult>' +
		'<Contents><Key>p/a.pdf</Key><Size>1024</Size><ETag>&quot;abc123&quot;</ETag><LastModified>2026-06-16T12:00:00.000Z</LastModified></Contents>' +
		'<Contents><Key>p/b.pdf</Key><Size>2048</Size><ETag>&quot;def456&quot;</ETag><LastModified>2026-06-16T13:00:00.000Z</LastModified></Contents>' +
		'<CommonPrefixes><Prefix>p/sub/</Prefix></CommonPrefixes>' +
		'</ListBucketResult>';

	it('extracts key, size, and unescaped etag per object', () => {
		const objects = parseListContents(xml);
		expect(objects).toHaveLength(2);
		expect(objects[0]).toEqual({ key: 'p/a.pdf', size: 1024, etag: '"abc123"', lastModified: '2026-06-16T12:00:00.000Z' });
		expect(objects[1]?.size).toBe(2048);
	});

	it('extracts common prefixes', () => {
		expect(parseCommonPrefixes(xml)).toEqual(['p/sub/']);
	});

	it('returns an empty array for a listing with no contents', () => {
		expect(parseListContents('<ListBucketResult></ListBucketResult>')).toEqual([]);
	});
});

describe('objectUrl', () => {
	it('path style puts bucket and key in the path', () => {
		expect(objectUrl({ endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: 'b', addressingStyle: 'path' }, 'a/b/c.txt'))
			.toBe('https://s3.us-east-1.amazonaws.com/b/a/b/c.txt');
	});
	it('virtual-hosted puts bucket in the host and key in the path', () => {
		expect(objectUrl({ endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: 'b', addressingStyle: 'virtual-hosted' }, 'k.txt'))
			.toBe('https://b.s3.us-east-1.amazonaws.com/k.txt');
	});
	it('percent-encodes spaces and unicode once per segment, preserving slashes', () => {
		expect(objectUrl({ endpoint: 'https://s3.amazonaws.com', region: 'us-east-1', bucket: 'b', addressingStyle: 'path' }, 'epub-test/Ancient Book café.epub'))
			.toBe('https://s3.amazonaws.com/b/epub-test/Ancient%20Book%20caf%C3%A9.epub');
	});
});

describe('buildObjectListUrl', () => {
	it('includes prefix, max-keys, and continuation token', () => {
		const url = buildObjectListUrl({ endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: 'b', addressingStyle: 'path' }, 'pre/fix/', 1, 'tok123');
		expect(url.startsWith('https://s3.us-east-1.amazonaws.com/b?')).toBe(true);
		expect(url).toContain('list-type=2');
		expect(url).toContain('max-keys=1');
		expect(url).toContain('prefix=pre%2Ffix%2F');
		expect(url).toContain('continuation-token=tok123');
	});
});

describe('ListObjectsV2 XML parsing', () => {
	const xml =
		'<ListBucketResult><IsTruncated>true</IsTruncated>' +
		'<Contents><Key>p/a.txt</Key></Contents>' +
		'<Contents><Key>p/b.txt</Key></Contents>' +
		'<NextContinuationToken>tok==</NextContinuationToken></ListBucketResult>';
	it('extracts keys in order', () => {
		expect(parseListedKeys(xml)).toEqual(['p/a.txt', 'p/b.txt']);
	});
	it('reads scalar tags and returns null when absent', () => {
		expect(parseXmlTag(xml, 'IsTruncated')).toBe('true');
		expect(parseXmlTag(xml, 'NextContinuationToken')).toBe('tok==');
		expect(parseXmlTag(xml, 'Missing')).toBeNull();
	});
});

describe('buildListUrl', () => {
	it('path style puts the bucket in the path', () => {
		expect(
			buildListUrl({ endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: 's3-dev-test', addressingStyle: 'path' }),
		).toBe('https://s3.us-east-1.amazonaws.com/s3-dev-test?list-type=2&max-keys=1');
	});

	it('virtual-hosted style puts the bucket in the host', () => {
		expect(
			buildListUrl({ endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', bucket: 's3-dev-test', addressingStyle: 'virtual-hosted' }),
		).toBe('https://s3-dev-test.s3.us-east-1.amazonaws.com/?list-type=2&max-keys=1');
	});

	it('trims a trailing slash on the endpoint', () => {
		expect(
			buildListUrl({ endpoint: 'https://s3.us-east-1.amazonaws.com/', region: 'us-east-1', bucket: 'b', addressingStyle: 'path' }),
		).toBe('https://s3.us-east-1.amazonaws.com/b?list-type=2&max-keys=1');
	});
});

describe('classifyListResult', () => {
	it('treats 200 as success and counts keys on the first page', () => {
		const body = '<ListBucketResult><Contents><Key>a.pdf</Key></Contents></ListBucketResult>';
		const result = classifyListResult(200, body, 's3-dev-test');
		expect(result.ok).toBe(true);
		expect(result.detail).toContain('reachable');
		expect(result.detail).toContain('1 object');
	});

	it('maps SignatureDoesNotMatch to a secret-key hint', () => {
		const body = '<Error><Code>SignatureDoesNotMatch</Code></Error>';
		const result = classifyListResult(403, body, 's3-dev-test');
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('SignatureDoesNotMatch');
		expect(result.detail).toContain('secret access key');
	});

	it('maps NoSuchBucket to a bucket hint', () => {
		const result = classifyListResult(404, '<Error><Code>NoSuchBucket</Code></Error>', 'missing');
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('no bucket by that name');
	});

	// A3 onboarding floor: O9 clock skew. AWS/R2 reject a request whose signed
	// timestamp is too far from server time with RequestTimeTooSkewed (HTTP 403).
	// Without naming it, the user sees a generic auth failure and re-checks keys
	// that are actually fine; the real fix is the device clock.
	it('maps RequestTimeTooSkewed to a device-clock hint', () => {
		const result = classifyListResult(403, '<Error><Code>RequestTimeTooSkewed</Code></Error>', 's3-dev-test');
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('RequestTimeTooSkewed');
		expect(result.detail).toContain('clock');
	});
});

describe('describeNetworkFailure', () => {
	// A3 onboarding floor: the no-response path. The classifier handles HTTP
	// responses; a thrown request (offline host, blocked origin) never reaches it.
	// This copy names the plain-language likely causes so the test button can teach.
	it('names CORS, offline, and a wrong endpoint as the likely causes', () => {
		const detail = describeNetworkFailure();
		expect(detail.toLowerCase()).toContain('cors');
		expect(detail.toLowerCase()).toContain('offline');
		expect(detail.toLowerCase()).toContain('endpoint');
	});
});
