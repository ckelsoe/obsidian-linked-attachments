import { formatLogLine, LogEntry } from '../logger';

describe('formatLogLine', () => {
	it('serializes an entry to one JSON line ending in a newline', () => {
		const entry: LogEntry = {
			ts: '2026-06-16T12:00:00.000Z',
			level: 'info',
			category: 'bucket',
			message: 'list success',
			op: 'list',
			status: 200,
		};
		const line = formatLogLine(entry);
		expect(line.endsWith('\n')).toBe(true);
		expect(line.split('\n')).toHaveLength(2); // content + trailing newline
		expect(JSON.parse(line)).toEqual(entry);
	});

	it('does not leak a secret it was never given (audit records metadata only)', () => {
		const entry: LogEntry = {
			ts: '2026-06-16T12:00:00.000Z',
			level: 'info',
			category: 'bucket',
			message: 'list success',
			op: 'list',
			method: 'GET',
			url: 'https://s3.us-east-1.amazonaws.com/s3-dev-test?list-type=2&max-keys=1',
		};
		const line = formatLogLine(entry);
		expect(line).not.toContain('Authorization');
		expect(line).not.toContain('aws4_request');
	});
});
