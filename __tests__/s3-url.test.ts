import { buildListUrl, classifyListResult } from '../s3-url';

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
});
