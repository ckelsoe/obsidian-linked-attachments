import { DEFAULT_SETTINGS, LinkedAttachmentsSettings } from '../../settings';
import { activeOS, migratedLocalAttachment, normalizePickedPath, selectActiveRoot } from './local-root';
import { resolveLocalRoot } from './local-backend';

function settingsWith(overrides: Partial<LinkedAttachmentsSettings>): LinkedAttachmentsSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('activeOS', () => {
	it('maps process.platform to the OS key', () => {
		expect(activeOS('win32')).toBe('win');
		expect(activeOS('darwin')).toBe('mac');
		expect(activeOS('linux')).toBe('linux');
		// Any other Unix reports as linux (the POSIX-ish slot).
		expect(activeOS('freebsd')).toBe('linux');
	});
});

describe('selectActiveRoot', () => {
	it('returns the active OS slot joined with the portable subpath', () => {
		const settings = settingsWith({
			localAttachment: { provider: 'onedrive-business', subpath: 'vault-docs', roots: { win: '%OneDriveCommercial%', mac: '~/Library/CloudStorage/OneDrive-Acme' } },
		});
		expect(selectActiveRoot(settings, 'win')).toBe('%OneDriveCommercial%/vault-docs');
		expect(selectActiveRoot(settings, 'mac')).toBe('~/Library/CloudStorage/OneDrive-Acme/vault-docs');
	});

	it('returns the bare root when the subpath is empty', () => {
		const settings = settingsWith({
			localAttachment: { provider: 'custom', subpath: '', roots: { win: 'D:\\Sync\\attachments' } },
		});
		expect(selectActiveRoot(settings, 'win')).toBe('D:\\Sync\\attachments');
	});

	it('trims a leading separator on the subpath so the join never doubles it', () => {
		const settings = settingsWith({
			localAttachment: { provider: 'custom', subpath: '/nested', roots: { linux: '/mnt/sync' } },
		});
		expect(selectActiveRoot(settings, 'linux')).toBe('/mnt/sync/nested');
	});

	it('sanitizes a traversal / absolute subpath so it cannot escape the root', () => {
		const settings = settingsWith({
			localAttachment: { provider: 'custom', subpath: '../../etc', roots: { linux: '/mnt/sync' } },
		});
		// The .. segments are dropped; the join stays under the root.
		expect(selectActiveRoot(settings, 'linux')).toBe('/mnt/sync/etc');
	});

	it('normalizes a backslash subpath and drops a drive segment', () => {
		const settings = settingsWith({
			localAttachment: { provider: 'custom', subpath: 'C:\\a\\b', roots: { win: 'D:\\Sync' } },
		});
		expect(selectActiveRoot(settings, 'win')).toBe('D:\\Sync/a/b');
	});

	it('preserves a legal POSIX subpath segment that contains a non-drive colon', () => {
		const settings = settingsWith({
			localAttachment: { provider: 'custom', subpath: 'Project: Alpha', roots: { linux: '/mnt/sync' } },
		});
		expect(selectActiveRoot(settings, 'linux')).toBe('/mnt/sync/Project: Alpha');
	});

	it("returns '' when the active OS has no slot set (new shape present)", () => {
		const settings = settingsWith({
			localAttachment: { provider: 'onedrive-business', subpath: 'x', roots: { win: '%OneDriveCommercial%' } },
		});
		expect(selectActiveRoot(settings, 'mac')).toBe('');
	});

	it('falls back to the legacy localRoot only when the new shape is absent', () => {
		const settings = settingsWith({ localRoot: '%OneDrive%\\legacy' });
		// Force the new shape to be absent (an un-migrated settings object).
		delete (settings as Partial<LinkedAttachmentsSettings>).localAttachment;
		expect(selectActiveRoot(settings, 'win')).toBe('%OneDrive%\\legacy');
	});
});

describe('normalizePickedPath (Windows)', () => {
	const env = {
		OneDriveCommercial: 'C:\\Users\\Bob\\OneDrive - Acme',
		OneDrive: 'C:\\Users\\Bob\\OneDrive - Acme',
		USERPROFILE: 'C:\\Users\\Bob',
	};

	it('rewrites a OneDrive pick to the %OneDriveCommercial% form', () => {
		expect(normalizePickedPath('C:\\Users\\Bob\\OneDrive - Acme\\vault', env, 'win32')).toBe('%OneDriveCommercial%\\vault');
	});

	it('prefers the longest (most specific) matching variable over USERPROFILE', () => {
		// Both OneDriveCommercial and USERPROFILE are prefixes; the longer one wins.
		const result = normalizePickedPath('C:\\Users\\Bob\\OneDrive - Acme\\vault', env, 'win32');
		expect(result.startsWith('%OneDriveCommercial%')).toBe(true);
	});

	it('matches case-insensitively on Windows', () => {
		expect(normalizePickedPath('c:\\users\\bob\\onedrive - acme\\vault', env, 'win32')).toBe('%OneDriveCommercial%\\vault');
	});

	it('does not match a partial path segment (Bob vs Bobby)', () => {
		expect(normalizePickedPath('C:\\Users\\Bobby\\vault', { USERPROFILE: 'C:\\Users\\Bob' }, 'win32')).toBe('C:\\Users\\Bobby\\vault');
	});

	it('leaves a path with no matching variable literal (the custom / NAS case)', () => {
		expect(normalizePickedPath('E:\\NAS\\vault', env, 'win32')).toBe('E:\\NAS\\vault');
	});
});

describe('normalizePickedPath (POSIX)', () => {
	it('collapses the home directory to a leading ~', () => {
		expect(normalizePickedPath('/Users/bob/Library/CloudStorage/OneDrive-Acme/vault', { HOME: '/Users/bob' }, 'darwin')).toBe('~/Library/CloudStorage/OneDrive-Acme/vault');
	});

	it('leaves a non-home path literal', () => {
		expect(normalizePickedPath('/mnt/data/vault', { HOME: '/Users/bob' }, 'linux')).toBe('/mnt/data/vault');
	});
});

describe('migratedLocalAttachment', () => {
	it('maps a non-empty legacy localRoot to a custom root under this OS', () => {
		expect(migratedLocalAttachment(undefined, 'D:\\Sync\\attachments', 'win')).toEqual({
			provider: 'custom',
			subpath: '',
			roots: { win: 'D:\\Sync\\attachments' },
		});
	});

	it('preserves the raw legacy value so it resolves exactly as before', () => {
		const migrated = migratedLocalAttachment(undefined, '%OneDriveCommercial%\\docs', 'win');
		expect(migrated?.roots.win).toBe('%OneDriveCommercial%\\docs');
	});

	it('does nothing when the new shape already exists', () => {
		const existing = { provider: 'dropbox' as const, subpath: 'x', roots: { win: 'C:\\a' } };
		expect(migratedLocalAttachment(existing, 'C:\\legacy', 'win')).toBeNull();
	});

	it('leaves a blank legacy value blank', () => {
		expect(migratedLocalAttachment(undefined, '', 'win')).toBeNull();
		expect(migratedLocalAttachment(undefined, '   ', 'win')).toBeNull();
		expect(migratedLocalAttachment(undefined, undefined, 'win')).toBeNull();
	});
});

describe('resolveLocalRoot still expands the new stored forms', () => {
	const KEY = 'LA_TEST_ONEDRIVE_ROOT';

	afterEach(() => {
		delete process.env[KEY];
	});

	it('expands an env-var form selected for this OS', () => {
		process.env[KEY] = '/tmp/synced-root';
		const settings = settingsWith({
			localAttachment: { provider: 'custom', subpath: 'sub', roots: { win: `%${KEY}%`, mac: `\${${KEY}}`, linux: `\${${KEY}}` } },
		});
		// selectActiveRoot produces the joined env-var form; resolveLocalRoot expands it.
		const selectedWin = selectActiveRoot(settings, 'win');
		expect(selectedWin).toBe(`%${KEY}%/sub`);
		const resolvedWin = resolveLocalRoot(selectedWin);
		expect(resolvedWin).not.toContain('%');
		expect(resolvedWin).toContain('synced-root');
		expect(resolvedWin).toContain('sub');
	});
});
