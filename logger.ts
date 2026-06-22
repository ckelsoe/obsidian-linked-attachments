import { App } from 'obsidian';

// Append-only JSONL logger. Writes one JSON object per line to
// <configDir>/plugins/<id>/audit.jsonl. The bucket audit trail is always on (it is
// a safety record, not diagnostics); the debug level is gated by a setting.
//
// Safety rules:
//   - Never log credentials or the Authorization header. Bucket entries record
//     operation metadata only (method, URL, status, bytes). SigV4 is header-based,
//     so the logged URL carries no secret.
//   - A log write must never block or break the operation it records. Writes are
//     serialized through a promise chain and each swallows its own error to the
//     console (the one sink that cannot depend on the log file).

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
	ts: string;
	level: LogLevel;
	category: string;
	message: string;
	[field: string]: unknown;
}

export interface BucketAuditEntry {
	op: string; // list | put | get | head | delete
	method: string;
	url: string;
	status?: number;
	bytes?: number;
	durationMs?: number;
	outcome: 'success' | 'error';
	detail?: string;
}

// Minimal sink so modules that issue bucket ops can depend on the audit surface
// without taking the whole Logger.
export interface AuditSink {
	audit(entry: BucketAuditEntry): void;
}

// Pure: serialize an entry to a single JSON line. Separated for unit testing.
export function formatLogLine(entry: LogEntry): string {
	return `${JSON.stringify(entry)}\n`;
}

export class Logger implements AuditSink {
	private writeChain: Promise<void> = Promise.resolve();

	constructor(
		private readonly app: App,
		private readonly pluginId: string,
		private readonly isDebugEnabled: () => boolean,
	) {}

	get logPath(): string {
		return `${this.app.vault.configDir}/plugins/${this.pluginId}/audit.jsonl`;
	}

	// Read the most recent log lines for the in-app log viewer (the user copies this
	// to report an issue). Returns the last maxLines lines so a long-lived log does
	// not load megabytes into a modal. Empty string when the log does not exist yet.
	async readRecent(maxLines = 1000): Promise<string> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.logPath))) {
			return '';
		}
		const text = await adapter.read(this.logPath);
		const lines = text.split('\n').filter((line) => line.length > 0);
		return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
	}

	debug(message: string, fields: Record<string, unknown> = {}): void {
		if (!this.isDebugEnabled()) {
			return;
		}
		this.record('debug', 'app', message, fields);
	}

	info(message: string, fields: Record<string, unknown> = {}): void {
		this.record('info', 'app', message, fields);
	}

	warn(message: string, fields: Record<string, unknown> = {}): void {
		console.warn(`Linked Attachments: ${message}`, fields);
		this.record('warn', 'app', message, fields);
	}

	error(message: string, fields: Record<string, unknown> = {}): void {
		console.error(`Linked Attachments: ${message}`, fields);
		this.record('error', 'app', message, fields);
	}

	// Records a bucket interaction. Always written, regardless of the debug toggle.
	audit(entry: BucketAuditEntry): void {
		const level: LogLevel = entry.outcome === 'error' ? 'warn' : 'info';
		this.record(level, 'bucket', `${entry.op} ${entry.outcome}`, { ...entry });
	}

	private record(level: LogLevel, category: string, message: string, fields: Record<string, unknown>): void {
		const entry: LogEntry = { ts: new Date().toISOString(), level, category, message, ...fields };
		const line = formatLogLine(entry);
		this.writeChain = this.writeChain
			.then(() => this.appendLine(line))
			.catch((error) => { console.error('Linked Attachments: failed to write to the log file.', error); });
	}

	private async appendLine(line: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(this.logPath)) {
			await adapter.append(this.logPath, line);
		} else {
			await adapter.write(this.logPath, line);
		}
	}
}
