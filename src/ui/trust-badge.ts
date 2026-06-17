import { VerificationTier } from '../pointer/codec';
import { defaultCanRemoveOriginal } from '../offload/pipeline';

// Trust badges (development-plan section 8 trust-copy table). One source of the
// user-facing trust verb so the pointer card, the scanner results, and the adopt
// list all describe a tier identically and honestly. The badge never claims more
// than the tier proved; `unlocksDelete` is derived from the real pipeline delete
// gate, so the "one-click delete" promise cannot drift away from what the engine
// actually permits.

export type BadgeKind = 'verified' | 'found' | 'asserted';

export interface TrustBadge {
	kind: BadgeKind;
	label: string;
	cardLine: string;
	tooltip: string;
	unlocksDelete: boolean;
}

const BADGES: Record<VerificationTier, Omit<TrustBadge, 'unlocksDelete'>> = {
	content: {
		kind: 'verified',
		label: 'Verified',
		cardLine: 'Confirmed byte-for-byte',
		tooltip: 'We downloaded and re-checked the bytes. They match.',
	},
	md5: {
		kind: 'verified',
		label: 'Verified',
		cardLine: 'Confirmed byte-for-byte',
		tooltip: 'We matched the file\'s MD5 checksum against your storage.',
	},
	existence: {
		kind: 'found',
		label: 'Found',
		cardLine: 'We see it exists',
		tooltip: 'The file is in your bucket. We have not re-checked its bytes yet.',
	},
	asserted: {
		kind: 'asserted',
		label: 'Asserted',
		cardLine: 'You told us it\'s there',
		tooltip: 'Recorded from your catalog. Open it once to verify.',
	},
};

export function trustBadge(tier: VerificationTier): TrustBadge {
	return { ...BADGES[tier], unlocksDelete: defaultCanRemoveOriginal(tier) };
}
