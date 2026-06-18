// Where a restore writes the file back: next to the pointer note (its CURRENT
// location), using the recorded original filename. The pointer note is the in-vault
// representation, so wherever the user has moved it is where the file belongs on
// restore - never the path recorded at offload time, which goes stale on a rename or
// a move synced from another device. Using the recorded original name also keeps the
// correct filename even if the pointer note's own basename was changed.
export function restoreTargetPath(pointerPath: string, originalName: string): string {
	const slash = pointerPath.lastIndexOf('/');
	const dir = slash >= 0 ? pointerPath.slice(0, slash) : '';
	return dir.length > 0 ? `${dir}/${originalName}` : originalName;
}
