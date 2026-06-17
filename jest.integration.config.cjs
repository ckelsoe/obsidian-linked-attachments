/** @type {import('jest').Config} */
const base = require('./jest.config.cjs');

// Runs ONLY the live integration tests (*.live.test.ts) against a real bucket.
// Invoked by `npm run test:integration`, which loads .env (local) or relies on
// the CI job's injected secrets. The default `npm test` never runs these.
module.exports = {
	...base,
	testMatch: ['**/*.live.test.ts'],
	testPathIgnorePatterns: ['/node_modules/'],
};
