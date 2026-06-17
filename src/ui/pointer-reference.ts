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
	lines.push(`Bucket: ${record.bucket}`);
	lines.push(`Key: ${record.key}`);
	if (record.hash !== null) {
		lines.push(`SHA-256: ${record.hash}`);
	}
	lines.push('Open this in your S3 app using the bucket and key above.');
	return lines.join('\n');
}
