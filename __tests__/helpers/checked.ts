/**
 * Checked access for tests. Returns the value with `undefined` and `null`
 * removed from its type, and fails the test with a clear message when the
 * value is missing. Used instead of non-null assertions (`x!`), which only
 * silence the type checker. Copied from the shared helper; add `at` from there
 * if a test needs it.
 */

/** The value itself, or a failure when it is null or undefined. */
export function defined<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) {
		throw new Error(`expected a value, got ${String(value)}`);
	}
	return value;
}
