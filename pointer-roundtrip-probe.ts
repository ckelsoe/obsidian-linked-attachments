import { App } from 'obsidian';
import { describeError } from './credentials';

// AC-G4: the R9 pointer round-trip probe.
//
// The offload step rewrites an in-note embed `![[file.ext]]` into `![[file.ext.md]]`
// so the pointer note transcludes natively. This probe answers the gating
// question: does that rewritten transclusion survive Obsidian's resolver and
// rename machinery without being flagged broken or rewritten?
//
// It is a scratch-vault probe: it creates a temporary folder, exercises the
// oracle (`metadataCache.resolvedLinks` and the reverse backlink), renames the
// pointer, then cleans up after itself. No network, no bucket, no credentials.
//
// This is spike scaffolding, not kept seed: it gets removed once the spike closes
// and the section-5 schema is finalized against the verdict.

const PROBE_DIR = 'linked-attachments-probe';

export interface ProbeCheck {
	name: string;
	pass: boolean;
	detail: string;
}

export interface PointerRoundTripResult {
	ok: boolean;
	checks: ProbeCheck[];
}

export async function runPointerRoundTripProbe(app: App): Promise<PointerRoundTripResult> {
	const dir = PROBE_DIR;
	const pointerPath = `${dir}/sample.pdf.md`;
	const renamedPointerPath = `${dir}/sample-renamed.pdf.md`;
	const hostPath = `${dir}/host.md`;

	// Refuse to clobber a pre-existing folder; leave the user's data alone.
	if (app.vault.getAbstractFileByPath(dir) !== null) {
		return {
			ok: false,
			checks: [{ name: 'setup', pass: false, detail: `A "${dir}" folder already exists; remove it and re-run.` }],
		};
	}

	const checks: ProbeCheck[] = [];
	try {
		await app.vault.createFolder(dir);
		// The pointer note stands in for an offloaded attachment (post-eviction:
		// the original sample.pdf is gone, only the pointer and the rewritten
		// embed remain).
		await app.vault.create(pointerPath, '---\nla_probe: true\n---\n\nPointer stand-in for sample.pdf.\n');
		// The host note carries the rewritten transclusion the offload step produces.
		await app.vault.create(hostPath, 'Embed below:\n\n![[sample.pdf.md]]\n');

		// CHECK 1: the rewritten embed resolves to the pointer note.
		const resolved = await waitUntil(() => linkCount(app, hostPath, pointerPath) > 0);
		checks.push({
			name: 'transclusion-resolves',
			pass: resolved,
			detail: resolved
				? `![[sample.pdf.md]] in host.md resolves to ${pointerPath}.`
				: `![[sample.pdf.md]] did not resolve. resolvedLinks[host]=${JSON.stringify(app.metadataCache.resolvedLinks[hostPath] ?? {})}`,
		});

		// CHECK 2: the pointer note's backlinks include the host (reverse resolvedLinks).
		const backlinks = backlinkSources(app, pointerPath);
		const hasBacklink = backlinks.includes(hostPath);
		checks.push({
			name: 'backlink-present',
			pass: hasBacklink,
			detail: hasBacklink
				? `host.md appears in the backlinks of the pointer note.`
				: `host.md not among pointer backlinks (found: ${backlinks.join(', ') || 'none'}).`,
		});

		// CHECK 3: renaming the pointer rewrites the embed and keeps it resolving.
		const pointerFile = app.vault.getFileByPath(pointerPath);
		if (pointerFile === null) {
			checks.push({ name: 'rename-survives', pass: false, detail: 'pointer note vanished before rename.' });
		} else {
			await app.fileManager.renameFile(pointerFile, renamedPointerPath);
			const resolvedAfter = await waitUntil(() => linkCount(app, hostPath, renamedPointerPath) > 0);
			const hostBody = await readIfExists(app, hostPath);
			const embedRewritten = hostBody !== null && hostBody.includes('sample-renamed.pdf.md');
			checks.push({
				name: 'rename-survives',
				pass: resolvedAfter && embedRewritten,
				detail: resolvedAfter && embedRewritten
					? `After rename, the embed updated to the new name and still resolves.`
					: `After rename: resolves=${resolvedAfter}, embedRewritten=${embedRewritten}.`,
			});
		}
	} catch (error) {
		checks.push({ name: 'probe-error', pass: false, detail: describeError(error) });
	} finally {
		await cleanup(app, dir, [hostPath, pointerPath, renamedPointerPath]);
	}

	return { ok: checks.length > 0 && checks.every((c) => c.pass), checks };
}

function linkCount(app: App, sourcePath: string, targetPath: string): number {
	const links = app.metadataCache.resolvedLinks[sourcePath];
	return links ? (links[targetPath] ?? 0) : 0;
}

// Reverse scan of resolvedLinks: every source whose links include targetPath.
function backlinkSources(app: App, targetPath: string): string[] {
	const sources: string[] = [];
	const all = app.metadataCache.resolvedLinks;
	for (const source of Object.keys(all)) {
		const links = all[source];
		if (links && Object.prototype.hasOwnProperty.call(links, targetPath)) {
			sources.push(source);
		}
	}
	return sources;
}

async function readIfExists(app: App, path: string): Promise<string | null> {
	const file = app.vault.getFileByPath(path);
	return file === null ? null : app.vault.read(file);
}

async function cleanup(app: App, dir: string, files: string[]): Promise<void> {
	for (const path of files) {
		const file = app.vault.getAbstractFileByPath(path);
		if (file !== null) {
			try {
				await app.fileManager.trashFile(file);
			} catch (error) {
				console.warn('Linked Attachments: probe cleanup failed for a file.', error);
			}
		}
	}
	const folder = app.vault.getAbstractFileByPath(dir);
	if (folder !== null) {
		try {
			await app.fileManager.trashFile(folder);
		} catch (error) {
			console.warn('Linked Attachments: probe cleanup failed for the folder.', error);
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}

// Polls a predicate until true or the timeout elapses. The metadata cache resolves
// links asynchronously after a vault write, so a poll is more reliable than a
// single read.
async function waitUntil(predicate: () => boolean, timeoutMs = 4000, intervalMs = 100): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) {
			return true;
		}
		await delay(intervalMs);
	}
	return predicate();
}
