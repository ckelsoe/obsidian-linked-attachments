import { extractExtension, KeyKind } from '../pointer/codec';
import { layoutHashKey } from '../key/layout';
import { sha256Hex } from '../hash/sha256';

// B7 dry-run preview (development-plan section 8). planOffload answers "what would
// offloading this file do?" without doing any of it. It takes no StorageBackend and
// no vault side-effect callbacks, so it CANNOT move, upload, write, or delete - the
// "nothing moved" guarantee is structural. The offload pipeline derives the same
// key/pointerPath/hash from these inputs, so the preview is honest by construction
// (test_plan_matches_pipeline); this module is the single source of that derivation.

export interface OffloadPlanInput {
	path: string;
	bytes: Uint8Array;
	contentType: string;
}

export interface OffloadPlanConfig {
	vaultPrefix: string;
	bucket: string;
}

export interface OffloadPlan {
	bucket: string;
	key: string;
	keyKind: KeyKind;
	pointerPath: string;
	originalName: string;
	originalExt: string;
	byteSize: number;
	contentType: string;
	hash: string; // the full sha256 the key suffix and the pointer identity come from
}

export async function planOffload(input: OffloadPlanInput, config: OffloadPlanConfig): Promise<OffloadPlan> {
	const hash = await sha256Hex(input.bytes);
	const { key, keyKind } = layoutHashKey({ vaultPrefix: config.vaultPrefix, originalPath: input.path, hash });
	const name = basename(input.path);
	return {
		bucket: config.bucket,
		key,
		keyKind,
		pointerPath: `${input.path}.md`,
		originalName: name,
		originalExt: extractExtension(name),
		byteSize: input.bytes.length,
		contentType: input.contentType,
		hash,
	};
}

// Human-readable size for the preview row. Binary units (1024) because object
// stores and file managers report in them; one decimal past bytes is enough.
export function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

function basename(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? path.slice(slash + 1) : path;
}
