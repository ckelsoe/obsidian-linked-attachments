import fc from 'fast-check';
import { runTrustRehearsal, TrustStage, TrustStageId } from './trust-ladder';
import { MemoryBackend } from '../storage/memory-backend';
import { GetRange, GetResult, StorageBackend } from '../storage/backend';

// S6 first-file round-trip trust check (development-plan section 8 happy-path
// storyboard: "uploaded, verified byte-for-byte, retrieved, matches"). The
// rehearsal exercises the user's REAL bucket end to end on a throwaway object
// before they trust the plugin with a real file: PUT -> HEAD/checksum -> GET ->
// byte-compare, then clean up. Tier-0 testable against MemoryBackend because each
// stage is one backend verb; the live modal that renders it is the parked human
// runtime check. A failure must stop at the exact stage and never falsely pass.

const payload = (s: string): Uint8Array => new TextEncoder().encode(s);
const KEY = 'charles-main/.linked-attachments-rehearsal--abc123.txt';

const ids = (stages: TrustStage[]): TrustStageId[] => stages.map((s) => s.id);
const statusOf = (stages: TrustStage[], id: TrustStageId): string =>
	stages.find((s) => s.id === id)?.status ?? 'missing';

describe('runTrustRehearsal', () => {
	it('AC1 test_all_four_stages_pass :: the round-trip passes on a healthy backend', async () => {
		const backend = new MemoryBackend();
		const result = await runTrustRehearsal({ backend, key: KEY, payload: payload('rehearsal bytes') });
		expect(result.ok).toBe(true);
		expect(result.failedStage).toBeNull();
		expect(ids(result.stages)).toEqual(['uploaded', 'verified', 'retrieved', 'matched']);
		expect(result.stages.every((s) => s.status === 'passed')).toBe(true);
		// cleanup removed the throwaway object: the rehearsal leaves no trace
		expect(backend.objectCount()).toBe(0);
	});

	it('AC2 test_upload_fault_stops_at_uploaded :: a failed PUT stops at stage one', async () => {
		const backend = new MemoryBackend();
		backend.faults.put = () => { throw new Error('dead creds'); };
		const result = await runTrustRehearsal({ backend, key: KEY, payload: payload('x') });
		expect(result.ok).toBe(false);
		expect(result.failedStage).toBe('uploaded');
		expect(statusOf(result.stages, 'uploaded')).toBe('failed');
		expect(statusOf(result.stages, 'verified')).toBe('pending');
		expect(statusOf(result.stages, 'retrieved')).toBe('pending');
		expect(backend.objectCount()).toBe(0);
	});

	it('AC3 test_verify_fault_stops_at_verified :: a failed HEAD stops at stage two', async () => {
		const backend = new MemoryBackend();
		backend.faults.head = () => { throw new Error('head failed'); };
		const result = await runTrustRehearsal({ backend, key: KEY, payload: payload('y') });
		expect(result.ok).toBe(false);
		expect(result.failedStage).toBe('verified');
		expect(statusOf(result.stages, 'uploaded')).toBe('passed');
		expect(statusOf(result.stages, 'verified')).toBe('failed');
		expect(statusOf(result.stages, 'retrieved')).toBe('pending');
		// the uploaded throwaway is still cleaned up despite the failure
		expect(backend.objectCount()).toBe(0);
	});

	it('AC4 test_retrieve_fault_stops_at_retrieved :: a failed GET stops at stage three', async () => {
		const backend = new MemoryBackend();
		backend.faults.get = () => { throw new Error('get failed'); };
		const result = await runTrustRehearsal({ backend, key: KEY, payload: payload('z') });
		expect(result.ok).toBe(false);
		expect(result.failedStage).toBe('retrieved');
		expect(statusOf(result.stages, 'verified')).toBe('passed');
		expect(statusOf(result.stages, 'matched')).toBe('pending');
	});

	it('AC5 test_match_failure_stops_at_matched :: drifted bytes fail the final compare', async () => {
		// A backend that uploads/heads honestly but returns DIFFERENT bytes on GET:
		// the byte-for-byte stage must catch it even though every earlier stage passed.
		const inner = new MemoryBackend();
		const tampering: StorageBackend = {
			capabilities: inner.capabilities,
			put: (k, b, s, o) => inner.put(k, b, s, o),
			head: (k) => inner.head(k),
			delete: (k) => inner.delete(k),
			list: (p, o) => inner.list(p, o),
			displayKey: (k) => inner.displayKey(k),
			async get(k: string, range?: GetRange): Promise<GetResult> {
				const real = await inner.get(k, range);
				const altered = new TextEncoder().encode('tampered');
				return {
					status: real.status,
					contentRange: real.contentRange,
					checksumSha256: real.checksumSha256,
					stream: real.stream.bind(real),
					arrayBuffer: async () => altered.buffer,
				};
			},
		};
		const result = await runTrustRehearsal({ backend: tampering, key: KEY, payload: payload('the real bytes') });
		expect(result.ok).toBe(false);
		expect(result.failedStage).toBe('matched');
		expect(statusOf(result.stages, 'retrieved')).toBe('passed');
		expect(statusOf(result.stages, 'matched')).toBe('failed');
	});

	it('AC6 test_onStage_reports_each_update :: the live callback sees every stage', async () => {
		const backend = new MemoryBackend();
		const seen: string[] = [];
		await runTrustRehearsal({
			backend,
			key: KEY,
			payload: payload('progress'),
			onStage: (stage) => seen.push(`${stage.id}:${stage.status}`),
		});
		// each stage is reported at least when it resolves to passed
		expect(seen).toContain('uploaded:passed');
		expect(seen).toContain('verified:passed');
		expect(seen).toContain('retrieved:passed');
		expect(seen).toContain('matched:passed');
	});

	it('fault_cleanup_failure_nonfatal :: a failed cleanup does not fail the rehearsal', async () => {
		const backend = new MemoryBackend();
		backend.faults.delete = () => { throw new Error('delete blocked'); };
		const result = await runTrustRehearsal({ backend, key: KEY, payload: payload('keep') });
		// the four stages still passed; cleanup is best-effort
		expect(result.ok).toBe(true);
		expect(result.failedStage).toBeNull();
	});

	it('prop_any_payload_roundtrips :: any non-empty payload passes all four stages', async () => {
		await fc.assert(
			fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 256 }), async (bytes) => {
				const backend = new MemoryBackend();
				const result = await runTrustRehearsal({ backend, key: KEY, payload: bytes });
				expect(result.ok).toBe(true);
				expect(backend.objectCount()).toBe(0);
			}),
			{ numRuns: 25 },
		);
	});
});
