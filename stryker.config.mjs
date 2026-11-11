// Mutation testing. Not a commit/CI gate (a full run takes minutes); run on
// demand with `npm run test:mutation` to find tests that pass without actually
// asserting behaviour. A high mutation score means the tests would catch a
// regression, not merely that they are green. Runs against the unit vitest
// config; the S3 live/integration suites are excluded (they need a real bucket).
// Read by vitest.config.mts in the test workers, which inherit this environment.
process.env.LINKED_ATTACHMENTS_MUTATION_RUN = "1";

export default {
	packageManager: "npm",
	testRunner: "vitest",
	vitest: {
		configFile: "vitest.config.mts",
	},
	mutate: ["**/*.ts", "!**/*.test.ts", "!**/*.d.ts", "!__mocks__/**"],
	reporters: ["clear-text", "progress"],
	coverageAnalysis: "perTest",
	ignorePatterns: ["main.js", "dist"],
};
