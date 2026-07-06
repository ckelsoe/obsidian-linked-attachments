// The managed block: a plugin-owned, regenerable region between the pointer
// frontmatter and the user body (spec section 5). It holds the open/download
// link as an `obsidian://` URI so that when the plugin is disabled the link
// renders as inert, readable text rather than a dead control. The R14 scanner
// reads identity from frontmatter only, never this block, so regenerating it can
// never change a pointer's identity.

export const MANAGED_START = '<!-- la:managed:start -->';
export const MANAGED_END = '<!-- la:managed:end -->';

export type ManagedBackendType = 's3' | 'local';

export interface ManagedBlockFields {
	id: string;
	originalName: string;
	// Which backends this pointer holds, so the block can show a working link to
	// each one. A local backend can be opened/revealed on disk; an S3 backend's
	// reference can be copied to open in an S3 app.
	backends: ManagedBackendType[];
}

// The links are convenience actions, never authoritative (spec section 3):
// identity always comes from frontmatter. Every action carries only the id +
// action + backend (no machine-specific path), so the block stays portable across
// machines and the handler resolves the real location live. The id is URI-encoded
// so an odd id cannot break the link or inject query parameters. When the plugin
// is disabled these render as inert, readable text.
export function renderManagedBlock(fields: ManagedBlockFields): string {
	const id = encodeURIComponent(fields.id);
	const label = fields.originalName.length > 0 ? fields.originalName : 'attachment';
	const link = (action: string, backend: ManagedBackendType): string =>
		`obsidian://linked-attachments?action=${action}&backend=${backend}&id=${id}`;
	const lines: string[] = [`**${label}**`];
	if (fields.backends.includes('local')) {
		lines.push(`- Local: [open](${link('open', 'local')}) · [reveal](${link('reveal', 'local')})`);
	}
	if (fields.backends.includes('s3')) {
		lines.push(`- S3: [copy reference](${link('copy', 's3')})`);
	}
	// A pointer always lists at least one backend, but never emit an empty block:
	// fall back to a bare open link.
	if (lines.length === 1) {
		lines.push(`[Open ${label}](obsidian://linked-attachments?action=open&id=${id})`);
	}
	return [MANAGED_START, ...lines, MANAGED_END].join('\n');
}
