// Jest mock for the `obsidian` runtime API. The published `obsidian` npm package
// is types-only (its `main` is empty), so unit tests running in plain Node have
// no implementation of the functions the plugin imports. This mock backs
// parseYaml / stringifyYaml with the `yaml` package so the pure codec's
// round-trip is exercised under test. lineWidth:0 disables line folding so long
// S3 / local paths stay on one line in test fixtures.
import { parse, stringify } from 'yaml';

export function parseYaml(yaml: string): unknown {
	return parse(yaml);
}

export function stringifyYaml(obj: unknown): string {
	return stringify(obj, { lineWidth: 0 });
}
