import { describeError } from './credentials';
import { sha256Base64 } from './sigv4';
import { S3Context, putObject, headObject, getObject, deleteObject, listObjects } from './s3-client';

// AC-G1/G2/G3 remote transport probe. Spike scaffolding (not kept seed): it writes
// and deletes temporary objects under a unique linked-attachments-probe/<runId>/
// prefix to exercise the full verb matrix, the checksum reality, and pagination
// against the real bucket, then cleans up after itself.

export interface TransportCheck {
	name: string;
	pass: boolean;
	detail: string;
}

export interface TransportProbeResult {
	ok: boolean;
	checks: TransportCheck[];
	notes: string[];
}

export async function runRemoteTransportProbe(ctx: S3Context, runId: string): Promise<TransportProbeResult> {
	const checks: TransportCheck[] = [];
	const notes: string[] = [];
	const prefix = `linked-attachments-probe/${runId}/`;
	const mainKey = `${prefix}probe.txt`;
	const body = 'A'.repeat(1024);
	const created: string[] = [];

	try {
		const checksum = await sha256Base64(body);

		// AC-G1 PUT (and AC-G2: is x-amz-checksum-sha256 accepted on PUT?).
		const put = await putObject(ctx, mainKey, body, checksum);
		created.push(mainKey);
		const putOk = put.status >= 200 && put.status < 300;
		checks.push({ name: 'G1 put', pass: putOk, detail: `PUT -> ${put.status}` });
		notes.push(`ETag (single-part PUT): ${put.headers['etag'] ?? '(none)'}`);
		notes.push(`G2 checksum PUT: x-amz-checksum-sha256 ${putOk ? 'accepted' : 'rejected'} (HTTP ${put.status})`);

		// AC-G1 HEAD (and AC-G2: is the checksum returned on HEAD?).
		const head = await headObject(ctx, mainKey, true);
		checks.push({ name: 'G1 head', pass: head.status === 200, detail: `HEAD -> ${head.status}, content-length ${head.headers['content-length'] ?? '?'}` });
		notes.push(`G2 checksum HEAD: x-amz-checksum-sha256 ${head.headers['x-amz-checksum-sha256'] ?? '(not returned)'}`);

		// AC-G1 GET full + byte-equality (and AC-G2 checksum on GET).
		const get = await getObject(ctx, mainKey, { checksumMode: true });
		const getOk = get.status === 200 && get.text === body;
		checks.push({ name: 'G1 get-full', pass: getOk, detail: `GET -> ${get.status}, byte-equal ${get.text === body}` });
		notes.push(`G2 checksum GET: x-amz-checksum-sha256 ${get.headers['x-amz-checksum-sha256'] ?? '(not returned)'}`);

		// AC-G1 range GET: bytes 0-511 of the 1024-byte object -> 206 + 512 bytes.
		const range = await getObject(ctx, mainKey, { range: { start: 0, end: 511 } });
		const rangeOk = range.status === 206 && range.text.length === 512 && range.text === body.slice(0, 512);
		checks.push({ name: 'G1 get-range', pass: rangeOk, detail: `range 0-511 -> ${range.status}, ${range.text.length} bytes` });

		// AC-G3 pagination + readable keys: add two more, list one page at a time.
		const k2 = `${prefix}a.txt`;
		const k3 = `${prefix}b.txt`;
		await putObject(ctx, k2, 'second');
		created.push(k2);
		await putObject(ctx, k3, 'third');
		created.push(k3);
		const page1 = await listObjects(ctx, prefix, 1);
		const page2 = page1.nextToken !== null ? await listObjects(ctx, prefix, 1, page1.nextToken) : null;
		const paginationOk =
			page1.status === 200 &&
			page1.keys.length === 1 &&
			page1.isTruncated &&
			page1.nextToken !== null &&
			page2 !== null &&
			page2.keys.length >= 1;
		checks.push({
			name: 'G3 list-pagination',
			pass: paginationOk,
			detail: `page1 keys=${page1.keys.length} truncated=${page1.isTruncated} token=${page1.nextToken !== null}; page2 keys=${page2?.keys.length ?? 0}`,
		});
		notes.push(`G3 readable keys: ${[...page1.keys, ...(page2?.keys ?? [])].join(', ')}`);

		// AC-G1 DELETE the main object.
		const del = await deleteObject(ctx, mainKey);
		const delOk = del.status === 204 || del.status === 200;
		checks.push({ name: 'G1 delete', pass: delOk, detail: `DELETE -> ${del.status}` });
		if (delOk) {
			const index = created.indexOf(mainKey);
			if (index >= 0) {
				created.splice(index, 1);
			}
		}
	} catch (error) {
		checks.push({ name: 'probe-error', pass: false, detail: describeError(error) });
	} finally {
		// Best-effort cleanup of everything still present.
		for (const key of created) {
			try {
				await deleteObject(ctx, key);
			} catch (error) {
				ctx.audit.audit({ op: 'delete', method: 'DELETE', url: key, outcome: 'error', detail: `cleanup failed: ${describeError(error)}` });
			}
		}
	}

	return { ok: checks.length > 0 && checks.every((c) => c.pass), checks, notes };
}
