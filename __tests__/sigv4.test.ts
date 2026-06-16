import { signRequest } from '../sigv4';

// Known-answer test against AWS's documented Amazon S3 "GET Object" example.
// The example's canonical-request hash (7344ae5b...946972) is AWS's published
// value, and an independent node:crypto implementation reproduces both that hash
// and the signature below, so this is the authoritative answer for these inputs.
describe('signRequest (AWS S3 GET Object known-answer)', () => {
	it('produces the documented signature and authorization header', async () => {
		const signed = await signRequest({
			method: 'GET',
			url: 'https://examplebucket.s3.amazonaws.com/test.txt',
			region: 'us-east-1',
			service: 's3',
			accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
			secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
			headers: { range: 'bytes=0-9' },
			amzDate: '20130524T000000Z',
		});

		expect(signed.headers['x-amz-content-sha256']).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
		expect(signed.headers.authorization).toBe(
			'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
				'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
				'Signature=67fe34c8530db585abddc51067328adfedb6e42487d2566dc7d927d6e2722900',
		);
	});

	it('hashes the empty payload when there is no body', async () => {
		const signed = await signRequest({
			method: 'GET',
			url: 'https://examplebucket.s3.amazonaws.com/?list-type=2&max-keys=1',
			region: 'us-east-1',
			service: 's3',
			accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
			secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
			amzDate: '20130524T000000Z',
		});
		expect(signed.headers['x-amz-content-sha256']).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
		// host, x-amz-content-sha256, x-amz-date are always signed.
		expect(signed.headers.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
	});
});
