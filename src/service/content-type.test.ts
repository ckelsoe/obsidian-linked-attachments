import { contentTypeForExtension, DEFAULT_CONTENT_TYPE } from './content-type';

describe('contentTypeForExtension', () => {
	it('maps known extensions case-insensitively', () => {
		expect(contentTypeForExtension('pdf')).toBe('application/pdf');
		expect(contentTypeForExtension('PDF')).toBe('application/pdf');
		expect(contentTypeForExtension('epub')).toBe('application/epub+zip');
		expect(contentTypeForExtension('png')).toBe('image/png');
	});

	it('falls back to octet-stream for unknown or empty extensions', () => {
		expect(contentTypeForExtension('xyz')).toBe(DEFAULT_CONTENT_TYPE);
		expect(contentTypeForExtension('')).toBe(DEFAULT_CONTENT_TYPE);
	});
});
