// Ambient declaration for @electron/remote, which is provided by Obsidian's desktop
// (Electron) runtime and marked external in the build, so it is never bundled. This
// file has no imports/exports on purpose: a global (script) declaration file so the
// ambient module is visible to a dynamic import() without an entry in node_modules.
// Only the tiny slice used for the local-folder picker is declared. Desktop-only.
// The Electron shell, used to open/reveal a local copy that lives OUTSIDE the
// vault (Obsidian's openWithDefaultApp only handles in-vault paths). External and
// provided by the desktop runtime; only the two calls used are declared.
declare module 'electron' {
	export const shell: {
		// Resolves to '' on success or an error string; never rejects.
		openPath(path: string): Promise<string>;
		showItemInFolder(fullPath: string): void;
	};
}

declare module '@electron/remote' {
	interface OpenDialogOptions {
		title?: string;
		defaultPath?: string;
		properties?: Array<'openDirectory' | 'createDirectory'>;
	}
	interface OpenDialogReturnValue {
		canceled: boolean;
		filePaths: string[];
	}
	export const dialog: {
		showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
	};
	// Same shell shape as the direct electron binding, reached through the main
	// process. Used as a fallback when the renderer's electron.shell is undefined
	// (context isolation).
	export const shell: {
		openPath(path: string): Promise<string>;
		showItemInFolder(fullPath: string): void;
	};
}
