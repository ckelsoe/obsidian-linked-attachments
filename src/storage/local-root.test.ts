import { DEFAULT_SETTINGS, LinkedAttachmentsSettings } from '../../settings';
import { activeMachine, hasMachineEntry, migratedLocalAttachment, selectActiveRoot } from './local-root';
import { resolveLocalRoot } from './local-backend';

function settingsWith(overrides: Partial<LinkedAttachmentsSettings>): LinkedAttachmentsSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('activeMachine', () => {
	it('returns the trimmed hostname', () => {
		expect(activeMachine('  DESK-01  ')).toBe('DESK-01');
	});
});

describe('selectActiveRoot', () => {
	it('returns the path of the entry matching this machine', () => {
		const settings = settingsWith({
			localAttachment: { machines: [
				{ machine: 'WIN-A', path: 'D:\\Sync\\attachments' },
				{ machine: 'WIN-B', path: 'E:\\Cloud\\attachments' },
			] },
		});
		expect(selectActiveRoot(settings, 'WIN-A')).toBe('D:\\Sync\\attachments');
		expect(selectActiveRoot(settings, 'WIN-B')).toBe('E:\\Cloud\\attachments');
	});

	it("returns '' when this machine has no entry", () => {
		const settings = settingsWith({
			localAttachment: { machines: [{ machine: 'WIN-A', path: 'D:\\Sync' }] },
		});
		expect(selectActiveRoot(settings, 'MAC-1')).toBe('');
	});

	it('falls back to the legacy localRoot only when the new shape is absent', () => {
		const settings = settingsWith({ localRoot: 'D:\\Legacy' });
		delete (settings as Partial<LinkedAttachmentsSettings>).localAttachment;
		expect(selectActiveRoot(settings, 'WIN-A')).toBe('D:\\Legacy');
	});
});

describe('hasMachineEntry', () => {
	it('reports whether a machine is already in the list', () => {
		const machines = [{ machine: 'WIN-A', path: 'D:\\x' }];
		expect(hasMachineEntry(machines, 'WIN-A')).toBe(true);
		expect(hasMachineEntry(machines, 'WIN-B')).toBe(false);
	});
});

describe('migratedLocalAttachment', () => {
	it('maps a non-empty legacy localRoot to an entry for this machine', () => {
		expect(migratedLocalAttachment(undefined, 'D:\\Sync\\attachments', 'WIN-A')).toEqual({
			machines: [{ machine: 'WIN-A', path: 'D:\\Sync\\attachments' }],
		});
	});

	it('carries the unreleased per-OS roots shape into an entry for this OS', () => {
		const raw = { roots: { win: 'D:\\Sync', mac: '/Users/x/Sync' } };
		expect(migratedLocalAttachment(raw, undefined, 'WIN-A', 'win32')).toEqual({
			machines: [{ machine: 'WIN-A', path: 'D:\\Sync' }],
		});
		expect(migratedLocalAttachment(raw, undefined, 'MAC-1', 'darwin')).toEqual({
			machines: [{ machine: 'MAC-1', path: '/Users/x/Sync' }],
		});
	});

	it('yields an empty list when the per-OS shape has no slot for this OS', () => {
		const raw = { roots: { win: 'D:\\Sync' } };
		expect(migratedLocalAttachment(raw, undefined, 'LNX-1', 'linux')).toEqual({ machines: [] });
	});

	it('does nothing when the machine-list shape already exists', () => {
		const raw = { machines: [{ machine: 'WIN-A', path: 'D:\\x' }] };
		expect(migratedLocalAttachment(raw, 'D:\\Legacy', 'WIN-A')).toBeNull();
	});

	it('returns null for a malformed localAttachment with neither machines nor roots', () => {
		// loadSettings then falls to its cloning branch, which guards with ?? [].
		expect(migratedLocalAttachment({}, undefined, 'WIN-A')).toBeNull();
	});

	it('leaves a blank legacy value blank', () => {
		expect(migratedLocalAttachment(undefined, '', 'WIN-A')).toBeNull();
		expect(migratedLocalAttachment(undefined, '   ', 'WIN-A')).toBeNull();
		expect(migratedLocalAttachment(undefined, undefined, 'WIN-A')).toBeNull();
	});
});

describe('resolveLocalRoot on a stored per-machine path', () => {
	it('resolves an absolute stored path unchanged in shape', () => {
		const settings = settingsWith({
			localAttachment: { machines: [{ machine: 'WIN-A', path: '/tmp/synced-root' }] },
		});
		const resolved = resolveLocalRoot(selectActiveRoot(settings, 'WIN-A'));
		expect(resolved.length).toBeGreaterThan(0);
		expect(resolved).toContain('synced-root');
	});

	it('fails closed to empty when this machine has no entry', () => {
		const settings = settingsWith({
			localAttachment: { machines: [{ machine: 'WIN-A', path: '/tmp/x' }] },
		});
		expect(resolveLocalRoot(selectActiveRoot(settings, 'MAC-1'))).toBe('');
	});
});
