// Ambient declaration for @electron/remote, which is provided by Obsidian's desktop
// (Electron) runtime and marked external in the build, so it is never bundled. This
// file has no imports/exports on purpose: a global (script) declaration file so the
// ambient module is visible to a dynamic import() without an entry in node_modules.
// Only the tiny slice used for the local-folder picker is declared. Desktop-only.
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
}
