// The managed block: a plugin-owned, regenerable region between the pointer
// frontmatter and the user body (spec section 5). It holds the open/download
// links as `obsidian://` URIs so that when the plugin is disabled the links
// render as inert, readable text rather than dead controls. The R14 scanner
// reads identity from frontmatter only, never this block, so regenerating it can
// never change a pointer's identity.
//
// The block renders as an Obsidian callout (`> [!linked-attachments]- Storage Links`)
// so it shows as a tidy, foldable box in Reading view and stays readable in
// Source/Live-preview. The `-` after the callout type is the fold marker
// (collapsed by default). Legacy pointers used HTML-comment markers instead;
// those constants stay exported so the codec can still locate and migrate them.

export const MANAGED_START = '<!-- la:managed:start -->';
export const MANAGED_END = '<!-- la:managed:end -->';

// The callout header: type `linked-attachments`, title `Storage Links`, `-` fold
// marker (rendered collapsed). Every managed callout begins with this line.
export const CALLOUT_HEADER = '> [!linked-attachments]- Storage Links';

export type ManagedBackendType = 's3' | 'local';

export interface ManagedBlockFields {
	id: string;
	// Which backends this pointer holds, so the block can show a working link to
	// each one. A local backend can be opened/revealed on disk; an S3 backend's
	// reference can be copied to open in an S3 app.
	backends: ManagedBackendType[];
}

// The links are convenience actions, never authoritative (spec section 3):
// identity always comes from frontmatter. Every action carries only the id +
// op + backend (no machine-specific path), so the block stays portable across
// machines and the handler resolves the real location live. The verb rides on its
// own `op` key, not `action`: Obsidian's protocol data reserves `action` for the
// registered route (`linked-attachments`), so reusing it for the verb would leave
// reveal/copy at the mercy of query-vs-route precedence. The id is URI-encoded so
// an odd id cannot break the link or inject query parameters. When the plugin is
// disabled these render as inert, readable text. The note is already named after
// the file, so the block carries no filename line of its own.
export function renderManagedBlock(fields: ManagedBlockFields): string {
	const id = encodeURIComponent(fields.id);
	const link = (op: string, backend: ManagedBackendType): string =>
		`obsidian://linked-attachments?op=${op}&backend=${backend}&id=${id}`;
	const rows: string[] = [];
	if (fields.backends.includes('local')) {
		rows.push(`> - Local: [open](${link('open', 'local')}) · [reveal](${link('reveal', 'local')})`);
	}
	if (fields.backends.includes('s3')) {
		rows.push(`> - S3: [open](${link('open', 's3')}) · [copy reference](${link('copy', 's3')})`);
	}
	// A pointer always lists at least one backend, but never emit an empty callout:
	// fall back to a bare open link row inside the callout.
	if (rows.length === 0) {
		rows.push(`> - [open](obsidian://linked-attachments?op=open&id=${id})`);
	}
	return [CALLOUT_HEADER, ...rows].join('\n');
}
