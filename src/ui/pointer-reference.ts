import { PointerRecord } from '../pointer/codec';
import { formatBytes } from '../offload/plan';

// The mobile pointer affordance (spec section 3 / 4). v1 delegates mobile transport
// to the user's own S3 app, so the pointer's job is to hand over actionable identity
// and honest facts: the filename, the real size and format (so the user decides
// before pulling on cellular), and the bucket + exact key to open in their S3 app.
// Pure and copyable; the device share-sheet handoff is the parked real-device test.
export function formatPointerReference(record: PointerRecord): string {
	const lines = [
		`File: ${record.originalName}`,
		`Size: ${formatBytes(record.byteSize)}`,
	];
	if (record.contentType.length > 0) {
		lines.push(`Format: ${record.contentType}`);
	}
	// One line per backend that holds the object, in read-preference order, each in
	// its own address form: an S3 backend by bucket + key (open it in an S3 app), a
	// local backend by its path under the configured local root (open it in the
	// file explorer).
	for (const backend of record.backends) {
		if (backend.type === 's3') {
			lines.push(`S3 bucket: ${backend.bucket}`);
			lines.push(`S3 key: ${backend.key}`);
		} else {
			lines.push(`Local path: ${backend.path}`);
		}
	}
	if (record.hash !== null) {
		lines.push(`SHA-256: ${record.hash}`);
	}
	return lines.join('\n');
}
