// Local type augmentations for the Obsidian API.
// Add type declarations here when the Obsidian types are missing or need extension.
// NEVER use `as any` to work around missing types. Add a proper declaration here instead.

import 'obsidian';

declare module 'obsidian' {
	interface PluginManifest {
		version: string;
	}

	// Undocumented but stable App method (used widely by community plugins) that
	// opens a vault-relative path in the OS default application. Declared here rather
	// than cast, per the no-`as any` rule. Desktop-only; calls are gated by
	// Platform.isDesktop (the checkout cycle is desktop-only, spec section 4a).
	interface App {
		openWithDefaultApp(path: string): Promise<void>;
	}
}
