import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						"eslint.config.mts",
						"manifest.json",
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ["__tests__/**/*.ts", "src/**/*.test.ts"],
		languageOptions: {
			globals: {
				...globals.jest,
			},
		},
	},
	{
		// Live integration harnesses run in Node (no Obsidian runtime, no browser
		// CORS), so they intentionally use the global fetch to reach the bucket.
		// Production plugin code uses requestUrl; these files are never bundled.
		files: ["src/**/*.live.test.ts"],
		rules: {
			"no-restricted-globals": "off",
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"main.js",
		"scripts",
		"esbuild.config.mjs",
		"version-bump.mjs",
		"versions.json",
		"package.json",
		"package-lock.json",
		"tsconfig.json",
		"jest.config.cjs",
		"jest.integration.config.cjs",
	]),
);
