import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

// Runs ONLY the live integration tests (*.live.test.ts) against a real bucket.
// Invoked by `npm run test:integration`, which loads .env (local) or relies on
// the CI job's injected secrets. The default `npm test` never runs these.
// Spread, not mergeConfig: mergeConfig concatenates include/exclude arrays, so
// the base exclusion of *.live.test.ts would survive.
export default defineConfig({
	...base,
	test: {
		...base.test,
		include: ['**/*.live.test.ts'],
		exclude: ['**/node_modules/**'],
		fileParallelism: false,
	},
});
