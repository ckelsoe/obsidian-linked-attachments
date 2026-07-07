// Parse a managed-block obsidian://linked-attachments URI into protocol params, so a
// click intercepted in rendered markdown can be dispatched in-app through the same
// path as an OS-delivered URL. Kept free of Obsidian/Electron imports so it is unit-
// testable. The returned shape is assignable to Obsidian's ObsidianProtocolData.
//
// `action` defaults to the registered route; a query `action` (legacy links carried
// the verb there before it moved to `op`) overrides it, which is why the handler
// reads `op` first and falls back to `action`. A malformed href yields the bare
// action, and the handler then no-ops on the missing id.
export function parsePointerLink(href: string): { action: string } & Record<string, string> {
	const params: { action: string } & Record<string, string> = { action: 'linked-attachments' };
	try {
		new URL(href).searchParams.forEach((value, key) => {
			params[key] = value;
		});
	} catch {
		// A malformed href leaves the bare action.
	}
	return params;
}
