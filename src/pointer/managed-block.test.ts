import { renderManagedBlock, MANAGED_START, MANAGED_END } from './managed-block';

describe('renderManagedBlock', () => {
	// The verb rides on `op`, never Obsidian's reserved `action`, and each backend
	// the pointer holds gets its own working link.
	it('emits op-keyed links per backend', () => {
		const block = renderManagedBlock({ id: 'la-1', originalName: 'book.epub', backends: ['local', 's3'] });
		expect(block).toContain('op=open&backend=local&id=la-1');
		expect(block).toContain('op=reveal&backend=local&id=la-1');
		expect(block).toContain('op=open&backend=s3&id=la-1');
		expect(block).toContain('op=copy&backend=s3&id=la-1');
		expect(block.startsWith(MANAGED_START)).toBe(true);
		expect(block.endsWith(MANAGED_END)).toBe(true);
	});

	// A filename containing Markdown link/emphasis syntax must not inject rendered
	// links or formatting into the pointer note: the visible label is escaped.
	it('escapes Markdown-significant characters in the label', () => {
		const block = renderManagedBlock({ id: 'la-2', originalName: 'a[x](evil)*b*.pdf', backends: ['local'] });
		expect(block).toContain('**a\\[x\\]\\(evil\\)\\*b\\*.pdf**');
		// The raw, unescaped label (which would render as a link) must be absent.
		expect(block).not.toContain('**a[x](evil)*b*.pdf**');
	});

	// The percent-encoded id keeps an odd id from breaking the link or injecting query
	// parameters.
	it('URI-encodes the id', () => {
		const block = renderManagedBlock({ id: 'la/weird id', originalName: 'x.pdf', backends: ['local'] });
		expect(block).toContain('id=la%2Fweird%20id');
	});
});
