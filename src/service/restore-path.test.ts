import { restoreTargetPath } from './restore-path';

// Restore must put the file back where the POINTER currently is, not at the path
// recorded at offload time. A pointer note is the in-vault representation: if the
// user renames or moves its folder (or it moved via sync on another device), the
// recorded la_original_path is stale, and restoring there recreates the old folder
// and leaves the new one empty (the bug Charles hit). Deriving the target from the
// pointer's own location + the recorded original name fixes it for every move path.

describe('restoreTargetPath', () => {
	it('restores next to the pointer, using the recorded original name', () => {
		expect(restoreTargetPath('epub-test-renamed/Ancient Book.epub.md', 'Ancient Book.epub')).toBe('epub-test-renamed/Ancient Book.epub');
	});

	it('handles a pointer at the vault root', () => {
		expect(restoreTargetPath('Ancient Book.epub.md', 'Ancient Book.epub')).toBe('Ancient Book.epub');
	});

	it('uses the recorded name even if the pointer note itself was renamed', () => {
		expect(restoreTargetPath('folder/renamed-note.md', 'original.epub')).toBe('folder/original.epub');
	});

	it('handles deeply nested folders', () => {
		expect(restoreTargetPath('a/b/c/file.pdf.md', 'file.pdf')).toBe('a/b/c/file.pdf');
	});
});
