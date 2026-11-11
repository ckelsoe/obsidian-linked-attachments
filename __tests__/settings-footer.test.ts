// The footer row is a flex row that wraps. Each "|" separator must share a
// nowrap item with the link after it, or a narrow pane can leave a stray "|"
// at the end or start of a line.

import type { App, Setting } from 'obsidian';
import type LinkedAttachmentsPlugin from '../main';
import { DEFAULT_SETTINGS } from '../settings';
import { LinkedAttachmentsSettingTab } from '../settings-tab';

// The stub has no UI classes; the tab and the modals it imports extend these.
vi.mock('obsidian', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	PluginSettingTab: class {
		constructor(public app: unknown) {}
	},
	Modal: class {},
}));

interface ElOptions {
	cls?: string;
	text?: string;
	href?: string;
	attr?: Record<string, string>;
}

interface FakeEl {
	tag: string;
	cls: string[];
	text: string;
	attrs: Record<string, string>;
	children: FakeEl[];
	empty(): void;
	addClass(c: string): void;
	createDiv(o?: ElOptions): FakeEl;
	createSpan(o?: ElOptions): FakeEl;
	createEl(tag: string, o?: ElOptions): FakeEl;
}

function fakeEl(tag: string): FakeEl {
	const append = (childTag: string, o: ElOptions = {}): FakeEl => {
		const child = fakeEl(childTag);
		if (o.cls !== undefined) child.cls.push(o.cls);
		if (o.text !== undefined) child.text = o.text;
		if (o.href !== undefined) child.attrs.href = o.href;
		Object.assign(child.attrs, o.attr ?? {});
		el.children.push(child);
		return child;
	};
	const el: FakeEl = {
		tag,
		cls: [],
		text: '',
		attrs: {},
		children: [],
		empty() {
			el.children = [];
		},
		addClass(c) {
			el.cls.push(c);
		},
		createDiv: (o) => append('div', o),
		createSpan: (o) => append('span', o),
		createEl: (childTag, o) => append(childTag, o),
	};
	return el;
}

describe('settings footer', () => {
	it('reads Version | GitHub | Discord | Report issues, each separator grouped with its link', () => {
		const plugin = {
			settings: structuredClone(DEFAULT_SETTINGS),
			manifest: { id: 'linked-attachments', version: '3.3.1' },
		} as unknown as LinkedAttachmentsPlugin;
		const app = { vault: { configDir: '.obsidian' } } as unknown as App;
		const tab = new LinkedAttachmentsSettingTab(app, plugin);
		const defs = tab.getSettingDefinitions();
		const last = defs[defs.length - 1] as unknown as {
			searchable?: boolean;
			render: (s: Setting) => void;
		};
		expect(last.searchable).toBe(false);

		const settingEl = fakeEl('div');
		last.render({ settingEl } as unknown as Setting);
		expect(settingEl.cls).toContain('linked-attachments-footer');
		const inner = settingEl.children[0];
		expect(inner?.cls).toEqual(['linked-attachments-footer-inner']);

		const [version, ...links] = inner?.children ?? [];
		expect(version?.text).toBe('Version 3.3.1');
		expect(links.map((l) => l.cls)).toEqual([
			['linked-attachments-footer-link'],
			['linked-attachments-footer-link'],
			['linked-attachments-footer-link'],
		]);
		for (const l of links) {
			expect(l.children.map((c) => [c.tag, c.text])[0]).toEqual([
				'span',
				'|',
			]);
			expect(l.children[1]?.attrs).toMatchObject({
				target: '_blank',
				rel: 'noopener',
			});
		}
		expect(
			links.map((l) => [l.children[1]?.text, l.children[1]?.attrs.href]),
		).toEqual([
			[
				'GitHub',
				'https://github.com/ckelsoe/obsidian-linked-attachments',
			],
			['Discord', 'https://discord.gg/gd6tKJDPj4'],
			[
				'Report issues',
				'https://github.com/ckelsoe/obsidian-linked-attachments/issues',
			],
		]);
	});
});
