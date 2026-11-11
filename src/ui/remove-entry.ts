// Removes `entry` from `list` by identity, not by a row index captured when a
// table was drawn. Settings search can render a second copy of a table, and a
// removal through one copy leaves the other's indices pointing at the wrong
// entry. Returns false when the entry is already gone, so a stale copy does
// nothing instead of removing a neighbour.
export function removeEntry<T>(list: T[], entry: T): boolean {
	const at = list.indexOf(entry);
	if (at === -1) return false;
	list.splice(at, 1);
	return true;
}
