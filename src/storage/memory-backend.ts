import {
	Capabilities,
	GetRange,
	GetResult,
	HeadResult,
	ListOptions,
	ListPage,
	PutBody,
	PutOptions,
	PutResult,
	StorageBackend,
} from './backend';

// STUB (la-p1-01 RED). Behaviour lands in the GREEN implementation commit.

export type FaultOp = 'put' | 'get' | 'head' | 'delete' | 'list';
export type FaultHook = (key: string) => void;

export interface SeedOptions {
	metadata?: Record<string, string>;
	etag?: string;
	contentType?: string;
}

export interface MemoryBackendOptions {
	capabilities?: Capabilities;
}

export class MemoryBackend implements StorageBackend {
	readonly capabilities: Capabilities = {
		upload: { presign: true, range: true, serverChecksum: true, conditionalWrite: true },
		access: 'presigned-url',
	};
	readonly faults: Partial<Record<FaultOp, FaultHook>> = {};

	constructor(_opts: MemoryBackendOptions = {}) {
		throw new Error('not implemented');
	}

	put(_key: string, _body: PutBody, _size: number, _opts?: PutOptions): Promise<PutResult> {
		throw new Error('not implemented');
	}

	get(_key: string, _range?: GetRange): Promise<GetResult> {
		throw new Error('not implemented');
	}

	head(_key: string): Promise<HeadResult> {
		throw new Error('not implemented');
	}

	delete(_key: string): Promise<void> {
		throw new Error('not implemented');
	}

	list(_prefix?: string, _opts?: ListOptions): Promise<ListPage> {
		throw new Error('not implemented');
	}

	displayKey(_key: string): string {
		throw new Error('not implemented');
	}

	seedObject(_key: string, _bytes: Uint8Array, _opts?: SeedOptions): Promise<void> {
		throw new Error('not implemented');
	}
}
