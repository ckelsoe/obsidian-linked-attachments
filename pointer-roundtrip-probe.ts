import { App } from 'obsidian';
import { describeError } from './credentials';

// AC-G4: the R9 pointer round-trip probe. Spike scaffolding (not kept seed).
//
// It exercises the representation the offload step produces: a pointer note at
// `file.ext.md` and an embed rewrite `![[file.ext]]` -> `![[file.ext.md]]` that
// transcludes the pointer natively. A real `file.ext` attachment is created
// alongside the pointer so the probe also checks that the explicit `.md`
// disambiguates the embed from the raw attachment. It then renames the pointer and
// records exactly what Obsidian does to the embed text, judging survival by the
// resolver (resolvedLinks), not a brittle string match.
//
// Everything is created under a unique linked-attachments-g4-probe/<runId>/ folder
// and trashed afterward.

const ROOT = 'linked-attachments-g4-probe';

export interface ProbeCheck {
	name: string;
	pass: boolean;
	detail: string;
}

export interface PointerRoundTripResult {
	ok: boolean;
	checks: ProbeCheck[];
	notes: string[];
}

export async function runPointerRoundTripProbe(app: App, runId: string): Promise<PointerRoundTripResult> {
	const dir = `${ROOT}/${runId}`;
	const attachmentPath = `${dir}/sample.pdf`;
	const pointerPath = `${dir}/sample.pdf.md`;
	const renamedPointerPath = `${dir}/sample-renamed.pdf.md`;
	const hostPath = `${dir}/host.md`;
	const checks: ProbeCheck[] = [];
	const notes: string[] = [];
	const created: string[] = [];

	try {
		await ensureFolder(app, ROOT);
		await app.vault.createFolder(dir);
		// A real attachment alongside the pointer = the pre-eviction state, so the
		// disambiguation check is meaningful.
		await app.vault.create(attachmentPath, 'placeholder bytes for sample.pdf');
		created.push(attachmentPath);
		await app.vault.create(pointerPath, '---\nla_probe: true\n---\n\nPointer stand-in for sample.pdf.\n');
		created.push(pointerPath);
		await app.vault.create(hostPath, 'Embed below:\n\n![[sample.pdf.md]]\n');
		created.push(hostPath);

		// CHECK 1: the rewritten embed resolves to the .md pointer.
		const resolvesToPointer = await waitUntil(() => linkCount(app, hostPath, pointerPath) > 0);
		checks.push({
			name: 'transclusion-resolves-to-pointer',
			pass: resolvesToPointer,
			detail: resolvesToPointer
				? '![[sample.pdf.md]] resolves to the .md pointer note.'
				: `did not resolve to the pointer. links=${JSON.stringify(app.metadataCache.resolvedLinks[hostPath] ?? {})}`,
		});

		// CHECK 2: it does NOT resolve to the raw sample.pdf (explicit .md disambiguates).
		const targetsRawPdf = linkCount(app, hostPath, attachmentPath) > 0;
		checks.push({
			name: 'disambiguates-from-raw-pdf',
			pass: !targetsRawPdf,
			detail: targetsRawPdf
				? 'the embed also resolves to the raw sample.pdf (ambiguous).'
				: 'the embed does not resolve to the raw sample.pdf; the explicit .md targets the pointer.',
		});

		// CHECK 3: the pointer note's backlinks include the host.
		const backlinks = backlinkSources(app, pointerPath);
		checks.push({
			name: 'backlink-present',
			pass: backlinks.includes(hostPath),
			detail: backlinks.includes(hostPath)
				? 'host.md appears in the backlinks of the pointer.'
				: `host.md not among pointer backlinks (found: ${backlinks.join(', ') || 'none'}).`,
		});

		notes.push(`embed text before rename: ${extractEmbed(await readIfExists(app, hostPath))}`);

		// CHECK 4: rename the pointer; the link must still resolve. The exact rewritten
		// text is recorded as a note (Obsidian may normalize it).
		const pointerFile = app.vault.getFileByPath(pointerPath);
		if (pointerFile === null) {
			checks.push({ name: 'rename-survives', pass: false, detail: 'pointer vanished before rename.' });
		} else {
			await app.fileManager.renameFile(pointerFile, renamedPointerPath);
			const renameIndex = created.indexOf(pointerPath);
			if (renameIndex >= 0) {
				created[renameIndex] = renamedPointerPath;
			}
			const resolvesAfter = await waitUntil(() => linkCount(app, hostPath, renamedPointerPath) > 0);
			notes.push(`embed text after rename: ${extractEmbed(await readIfExists(app, hostPath))}`);
			checks.push({
				name: 'rename-survives',
				pass: resolvesAfter,
				detail: resolvesAfter
					? 'after rename the embed still resolves to the renamed pointer.'
					: 'after rename the embed no longer resolves.',
			});
		}
	} catch (error) {
		checks.push({ name: 'probe-error', pass: false, detail: describeError(error) });
	} finally {
		await cleanup(app, dir, created);
	}

	return { ok: checks.length > 0 && checks.every((c) => c.pass), checks, notes };
}

function linkCount(app: App, sourcePath: string, targetPath: string): number {
	const links = app.metadataCache.resolvedLinks[sourcePath];
	return links ? (links[targetPath] ?? 0) : 0;
}

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

function extractEmbed(body: string | null): string {
	if (body === null) {
		return '(host file missing)';
	}
	const match = /!\[\[([^\]]+)\]\]/.exec(body);
	return match?.[1] !== undefined ? `![[${match[1]}]]` : '(no embed found)';
}

async function readIfExists(app: App, path: string): Promise<string | null> {
	const file = app.vault.getFileByPath(path);
	return file === null ? null : app.vault.read(file);
}

async function ensureFolder(app: App, path: string): Promise<void> {
	if (app.vault.getAbstractFileByPath(path) === null) {
		try {
			await app.vault.createFolder(path);
		} catch {
			// A concurrent create is fine; ignore.
		}
	}
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
