// The managed block: a plugin-owned, regenerable region between the pointer
// frontmatter and the user body (spec section 5). It holds the open/download
// link as an `obsidian://` URI so that when the plugin is disabled the link
// renders as inert, readable text rather than a dead control. The R14 scanner
// reads identity from frontmatter only, never this block, so regenerating it can
// never change a pointer's identity.

export const MANAGED_START = '<!-- la:managed:start -->';
export const MANAGED_END = '<!-- la:managed:end -->';

export interface ManagedBlockFields {
	id: string;
	originalName: string;
}

// The open link is a convenience, never authoritative (spec section 3): identity
// always comes from frontmatter. The id is URI-encoded so an id containing odd
// characters cannot break the link or inject query parameters.
export function renderManagedBlock(fields: ManagedBlockFields): string {
	const uri = `obsidian://linked-attachments?action=open&id=${encodeURIComponent(fields.id)}`;
	const label = fields.originalName.length > 0 ? fields.originalName : 'attachment';
	return [MANAGED_START, `[Open ${label}](${uri})`, MANAGED_END].join('\n');
}
