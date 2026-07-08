// Jest mock for the `obsidian` runtime API. The published `obsidian` npm package
// is types-only (its `main` is empty), so unit tests running in plain Node have
// no implementation of the functions the plugin imports. Obsidian implements
// parseYaml / stringifyYaml with js-yaml internally, so this mock backs them with
// js-yaml too, keeping the pure codec's round-trip identical under test to the
// app. lineWidth:-1 disables line folding, matching the codec's prior direct
// js-yaml call so long S3 / local paths stay on one line in test fixtures.
import { dump, load } from 'js-yaml';

export function parseYaml(yaml: string): unknown {
	return load(yaml);
}

export function stringifyYaml(obj: unknown): string {
	return dump(obj, { lineWidth: -1 });
}
