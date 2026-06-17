import { PutBody } from './backend';

// Normalize any StorageBackend put body (bytes / Blob / stream) to a single
// Uint8Array. Shared by MemoryBackend and S3Backend so both treat a body
// identically (the "second copy is the moment to parameterize" rule).
export async function bodyToBytes(body: PutBody): Promise<Uint8Array> {
	if (body instanceof Uint8Array) {
		return body.slice();
	}
	if (body instanceof Blob) {
		return new Uint8Array(await body.arrayBuffer());
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		if (value !== undefined) {
			chunks.push(value);
			total += value.length;
		}
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

// A fresh ArrayBuffer-backed copy of the bytes (the form an HTTP client wants as
// a request body).
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const out = new Uint8Array(bytes.length);
	out.set(bytes);
	return out.buffer;
}

// A one-shot ReadableStream that emits the bytes once and closes.
export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller): void {
			controller.enqueue(bytes.slice());
			controller.close();
		},
	});
}
