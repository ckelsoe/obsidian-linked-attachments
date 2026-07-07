import { renderManagedBlock, CALLOUT_HEADER } from './managed-block';

describe('renderManagedBlock', () => {
	// The block renders as an Obsidian callout: a `> [!linked-attachments]- Storage Links`
	// header followed by one `> - ...` row per backend. The verb rides on `op`, never
	// Obsidian's reserved `action`, and each backend gets its own working link.
	it('emits a callout with op-keyed links per backend', () => {
		const block = renderManagedBlock({ id: 'la-1', backends: ['local', 's3'] });
		const lines = block.split('\n');
		expect(lines[0]).toBe(CALLOUT_HEADER);
		expect(lines[0]).toBe('> [!linked-attachments]- Storage Links');
		// Each backend's links live on a `> - ...` callout row.
		expect(block).toContain('> - Local: [open](obsidian://linked-attachments?op=open&backend=local&id=la-1) · [reveal](obsidian://linked-attachments?op=reveal&backend=local&id=la-1)');
		expect(block).toContain('> - S3: [open](obsidian://linked-attachments?op=open&backend=s3&id=la-1) · [copy reference](obsidian://linked-attachments?op=copy&backend=s3&id=la-1)');
		// Every line is inside the callout (starts with `>`); no bare filename line.
		for (const line of lines) {
			expect(line.startsWith('>')).toBe(true);
		}
		expect(block).not.toContain('**');
	});

	// A pointer always holds at least one backend, but the empty case still renders a
	// bare open row inside the callout rather than an empty box.
	it('falls back to a bare open row inside the callout when no backend matches', () => {
		const block = renderManagedBlock({ id: 'la-3', backends: [] });
		expect(block.split('\n')[0]).toBe(CALLOUT_HEADER);
		expect(block).toContain('> - [open](obsidian://linked-attachments?op=open&id=la-3)');
	});

	// The percent-encoded id keeps an odd id from breaking the link or injecting query
	// parameters.
	it('URI-encodes the id', () => {
		const block = renderManagedBlock({ id: 'la/weird id', backends: ['local'] });
		expect(block).toContain('id=la%2Fweird%20id');
	});
});
