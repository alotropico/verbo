/** Extras only. The open chat stays the anchor and is never stored here. */

export function toggleChatSelection(
  anchorId: string,
  extras: readonly string[],
  id: string,
): readonly string[] {
  if (id.length === 0 || id === anchorId) return extras;
  if (extras.includes(id)) return extras.filter((item) => item !== id);
  return [...extras, id];
}

export function rangeChatSelection(
  anchorId: string,
  orderedIds: readonly string[],
  id: string,
): string[] {
  const end = orderedIds.indexOf(id);
  if (end < 0) return [];
  const anchorIndex = orderedIds.indexOf(anchorId);
  const start = anchorIndex < 0 ? 0 : anchorIndex;
  const [from, to] = start < end ? [start, end] : [end, start];
  return orderedIds.slice(from, to + 1).filter((item) => item !== anchorId);
}

export function visibleChatSelection(
  anchorId: string,
  orderedIds: readonly string[],
): string[] {
  return orderedIds.filter((id) => id !== anchorId);
}
