// Shared SHA-256 helpers over raw bytes.
//
// Pure (no `obsidian` import) and Web Crypto based (`crypto.subtle`), like the
// kept-seed signer in sigv4.ts, so it runs unchanged in Obsidian's Electron
// runtime and in Node for the unit tests with no network. The content sha256 is
// the plugin's permanent identity (spec section 3), the rehash target for
// verify-before-delete (spec section 10 F1), and the input to the readable key
// layout (spec section 3) - one hashing module, shared, per the workspace
// "second copy is the moment to parameterize" rule.

// Web Crypto's digest wants an ArrayBuffer-backed view. TextEncoder/Uint8Array
// can be backed by a SharedArrayBuffer, which TS 5.8 will not accept as the
// BufferSource Web Crypto requires; copying into a freshly allocated Uint8Array
// fixes the type without a cast (same approach as sigv4.ts).
function arrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(bytes.byteLength);
	out.set(bytes);
	return out;
}

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
	const result = await crypto.subtle.digest('SHA-256', arrayBufferView(bytes));
	return new Uint8Array(result);
}

// Lowercase hex sha256. This is the identity form recorded in pointer
// frontmatter (`hash`) and object metadata.
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	let hex = '';
	for (const b of await digest(bytes)) {
		hex += b.toString(16).padStart(2, '0');
	}
	return hex;
}

// Base64 sha256. This is the wire form S3 wants for `x-amz-checksum-sha256`
// (the header value is base64, not hex) used on the checksummed-PUT verify path.
export async function sha256Base64(bytes: Uint8Array): Promise<string> {
	let binary = '';
	for (const b of await digest(bytes)) {
		binary += String.fromCharCode(b);
	}
	return btoa(binary);
}
