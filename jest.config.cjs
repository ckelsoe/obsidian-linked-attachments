/** @type {import('jest').Config} */
module.exports = {
	// Pin the project root to this plugin directory. Without it, when the plugin
	// is checked out inside the workspace monorepo, jest resolves rootDir to a
	// shared ancestor and crawls sibling plugins (duplicate `obsidian` mocks, slow
	// haste map, broken transforms). In CI only this repo is checked out, so the
	// default already equals __dirname; pinning makes local match CI.
	rootDir: __dirname,
	roots: ['<rootDir>'],
	testEnvironment: 'node',
	testMatch: ['**/__tests__/**/*.test.ts', '**/src/**/*.test.ts'],
	// Live integration tests (*.live.test.ts) hit a real bucket and are excluded
	// from the default run. They run only via `npm run test:integration`.
	testPathIgnorePatterns: ['/node_modules/', '\\.live\\.test\\.ts$'],
	transform: {
		'^.+\\.ts$': ['ts-jest', {
			tsconfig: {
				// Override ESNext module to CommonJS for Jest compatibility
				module: 'CommonJS',
			},
		}],
	},
};
