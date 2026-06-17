// Best-effort content type from a file extension, for the object's Content-Type
// and the x-amz-meta-contenttype recovery field. Pure and unit-testable. Unknown
// extensions fall back to application/octet-stream (a safe binary default).

const CONTENT_TYPES: Record<string, string> = {
	pdf: 'application/pdf',
	epub: 'application/epub+zip',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	doc: 'application/msword',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	txt: 'text/plain',
	md: 'text/markdown',
	csv: 'text/csv',
	json: 'application/json',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	mp3: 'audio/mpeg',
	m4a: 'audio/mp4',
	wav: 'audio/wav',
	mp4: 'video/mp4',
	mov: 'video/quicktime',
	zip: 'application/zip',
};

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

export function contentTypeForExtension(extension: string): string {
	return CONTENT_TYPES[extension.toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}
