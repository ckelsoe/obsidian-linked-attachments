import { PointerRecord } from '../pointer/codec';
import { OffloadResult } from '../offload/pipeline';
import { trustBadge } from './trust-badge';

// User-facing trust copy that surfaces the badge in plain notices. Kept pure so the
// wording is testable and honest: a pointer line names its tier's badge, and an
// offload outcome states the achieved tier and whether the original was actually
// removed - it never reports a deletion that did not happen.

export function pointerTrustLine(record: PointerRecord): string {
	const badge = trustBadge(record.verificationTier);
	return `${badge.label}: ${badge.cardLine}`;
}

export function offloadOutcomeLine(fileName: string, result: OffloadResult): string {
	if (!result.ok) {
		return `Offload of ${fileName} did not complete: ${result.error ?? 'unknown error'}. Your file was not removed.`;
	}
	const tier = result.record?.verificationTier ?? 'asserted';
	const badge = trustBadge(tier);
	if (result.deduped) {
		// Content-dedup: the bytes were already in storage, so this linked to the
		// existing object instead of uploading a second copy (spec section 10).
		return result.removed
			? `${fileName} is already in storage; linked here (${badge.label}) and the local file was moved to trash.`
			: `${fileName} is already in storage; linked here (${badge.label}). The local file was kept.`;
	}
	if (result.removed) {
		return `Offloaded ${fileName} (${badge.label}). The local file was moved to trash.`;
	}
	return `Offloaded ${fileName} (${badge.label}). The local file was kept (not yet at the delete-gate tier).`;
}
