import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// TypeScript first. The build writes main.js next to main.ts, and with the
		// default order a test importing `../main` would run the last build, not the
		// source.
		extensions: ['.ts', '.mts', '.mjs', '.js', '.json'],
		// Tests run against the stub, never the real (types-only) package.
		alias: {
			obsidian: fileURLToPath(
				new URL('./__mocks__/obsidian.ts', import.meta.url),
			),
		},
	},
	test: {
		globals: true,
		environment: 'node',
		include: ['__tests__/**/*.test.ts', 'src/**/*.test.ts'],
		// Live integration tests (*.live.test.ts) hit a real bucket and are excluded
		// from the default run. They run only via `npm run test:integration`.
		exclude: ['**/node_modules/**', '**/*.live.test.ts'],
		// Stryker's instrumented code runs some 20 times slower, so a mutation run
		// (stryker.config.mjs sets the flag) gets a far wider limit.
		testTimeout: process.env.LINKED_ATTACHMENTS_MUTATION_RUN
			? 600_000
			: 30_000,
	},
});
