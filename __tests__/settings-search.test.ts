// Obsidian's settings search finds a setting by its name, description and
// aliases. A section drawn by hand has none of those unless it is given them,
// so every one of them except the footer must carry a name and be searchable.
// Settings that do not apply are hidden with `visible`, which also drops them
// from search.

import type { App, Setting } from 'obsidian';
import type LinkedAttachmentsPlugin from '../main';
import { DEFAULT_SETTINGS, type LinkedAttachmentsSettings } from '../settings';
import { testConnection } from '../s3-connection';
import { LinkedAttachmentsSettingTab } from '../settings-tab';

vi.mock('../s3-connection', () => ({ testConnection: vi.fn() }));

// The stub has no UI classes; the tab and the modals it imports extend these.
vi.mock('obsidian', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	PluginSettingTab: class {
		constructor(public app: unknown) {}
		update(): void {}
		refreshDomState(): void {}
	},
	Modal: class {},
}));

interface Item {
	type?: string;
	name?: string;
	desc?: unknown;
	aliases?: string[];
	searchable?: boolean | (() => boolean);
	visible?: boolean | (() => boolean);
	render?: unknown;
	items?: Item[];
}

function leaves(items: Item[]): Item[] {
	return items.flatMap((i) => (i.items ? leaves(i.items) : [i]));
}

// Obsidian treats an absent `searchable` as true and also accepts a callback.
function isSearchable(i: Item): boolean {
	return typeof i.searchable === 'function'
		? i.searchable()
		: i.searchable !== false;
}

function makeTab(overrides: Partial<LinkedAttachmentsSettings> = {}): {
	tab: LinkedAttachmentsSettingTab;
	settings: LinkedAttachmentsSettings;
	items: Item[];
} {
	const settings = { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
	const plugin = {
		settings,
		manifest: { id: 'linked-attachments', version: '3.3.1' },
		saveSettings: () => Promise.resolve(),
	} as unknown as LinkedAttachmentsPlugin;
	const app = { vault: { configDir: '.obsidian' } } as unknown as App;
	const tab = new LinkedAttachmentsSettingTab(app, plugin);
	const items = leaves(tab.getSettingDefinitions());
	return { tab, settings, items };
}

function isVisible(items: Item[], name: string): boolean {
	const item = items.find((i) => i.name === name);
	expect(item).toBeDefined();
	const v = item?.visible;
	return typeof v === 'function' ? v() : v !== false;
}

describe('settings search', () => {
	it('gives every hand-drawn section a name and makes it searchable, except the footer', () => {
		const { items } = makeTab({ storageMode: 'local-s3' });
		const custom = items.filter((i) => i.render !== undefined && !i.type);
		const hidden = custom.filter((i) => !isSearchable(i));
		expect(hidden.map((i) => i.name)).toEqual(['About']);
		const searchable = custom.filter(isSearchable);
		expect(searchable.length).toBeGreaterThan(0);
		for (const i of searchable) {
			expect(typeof i.name).toBe('string');
			expect(i.name).not.toBe('');
			expect(typeof i.desc).toBe('string');
			expect(i.aliases?.length).toBeGreaterThan(0);
		}
	});

	it('finds the sections people look for by name', () => {
		const { items } = makeTab({ storageMode: 'local-s3' });
		const names = items.map((i) => i.name);
		for (const n of [
			'Local folders per machine',
			'Access key',
			'Secret access key',
			'Connection',
			'Copy all files to the local mirror now',
			'Copy all files to the S3 mirror now',
			'Rehearse a round-trip',
			'Types to offload',
			'Scan the whole vault now',
			'View log',
		])
			expect(names).toContain(n);
	});
});

describe('auto-offload settings show only while they apply', () => {
	it('hides the trigger and idle window while auto-offload is off', () => {
		const { items } = makeTab({ autoOffloadEnabled: false });
		expect(isVisible(items, 'Trigger')).toBe(false);
		expect(isVisible(items, 'Idle window in minutes')).toBe(false);
	});

	it('shows the trigger but not the idle window in prompt mode', () => {
		const { items } = makeTab({
			autoOffloadEnabled: true,
			autoOffloadTriggerMode: 'prompt',
		});
		expect(isVisible(items, 'Trigger')).toBe(true);
		expect(isVisible(items, 'Idle window in minutes')).toBe(false);
	});

	it('shows both in idle mode', () => {
		const { items } = makeTab({
			autoOffloadEnabled: true,
			autoOffloadTriggerMode: 'idle-debounce',
		});
		expect(isVisible(items, 'Trigger')).toBe(true);
		expect(isVisible(items, 'Idle window in minutes')).toBe(true);
	});

	it('re-evaluates visibility after a change, and rebuilds on a storage mode change', async () => {
		const { tab, settings, items } = makeTab({ autoOffloadEnabled: false });
		const refresh = vi.spyOn(tab, 'refreshDomState');
		const update = vi.spyOn(tab, 'update');

		await tab.setControlValue('autoOffloadEnabled', true);
		expect(settings.autoOffloadEnabled).toBe(true);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(update).not.toHaveBeenCalled();
		// The predicates read live settings, so the same definitions now say visible.
		expect(isVisible(items, 'Trigger')).toBe(true);

		await tab.setControlValue('storageMode', 'local-only');
		expect(update).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});

describe('connection test row', () => {
	interface FakeRow {
		setting: Setting;
		click: () => void;
		disabled: boolean[];
		status: string[];
	}

	// Search results render a second copy of the row while the tab's copy exists.
	function renderRow(tab: LinkedAttachmentsSettingTab): FakeRow {
		const row: FakeRow = {
			setting: {} as Setting,
			click: () => {},
			disabled: [],
			status: [],
		};
		const statusEl = {
			setText: (t: string) => row.status.push(t),
			toggleClass: () => {},
		};
		const button = {
			setButtonText: () => button,
			onClick: (handler: () => void) => {
				row.click = handler;
				return button;
			},
			setDisabled: (d: boolean) => row.disabled.push(d),
		};
		row.setting = {
			descEl: { createDiv: () => statusEl },
			addButton: (cb: (b: typeof button) => void) => {
				cb(button);
			},
		} as unknown as Setting;
		const item = leaves(
			tab.getSettingDefinitions() as unknown as Item[],
		).find((i) => i.name === 'Connection') as unknown as {
			render: (s: Setting) => void;
		};
		item.render(row.setting);
		return row;
	}

	it('finishes a test in the row that started it, even after a second render', async () => {
		const settings = {
			...structuredClone(DEFAULT_SETTINGS),
			endpoint: 'https://example.test',
			bucket: 'b',
		};
		const plugin = {
			settings,
			manifest: { id: 'linked-attachments', version: '3.3.1' },
			credentials: {
				getCredentials: () => ({
					accessKeyId: 'a',
					secretAccessKey: 's',
				}),
				hasCompleteCredentials: () => true,
			},
			logger: { info: () => {} },
		} as unknown as LinkedAttachmentsPlugin;
		const app = { vault: { configDir: '.obsidian' } } as unknown as App;
		const tab = new LinkedAttachmentsSettingTab(app, plugin);

		let finish: (r: { ok: boolean; detail: string }) => void = () => {};
		vi.mocked(testConnection).mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);

		const first = renderRow(tab);
		first.click();
		expect(first.disabled).toEqual([true]);

		const second = renderRow(tab);
		finish({ ok: true, detail: 'Connected.' });
		await vi.waitFor(() => expect(first.disabled).toEqual([true, false]));
		expect(first.status[first.status.length - 1]).toBe('Connected.');
		expect(second.disabled).toEqual([]);
		expect(second.status).not.toContain('Connected.');
	});
});
