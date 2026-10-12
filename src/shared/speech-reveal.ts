export type SpeechCaption = {
  messageId: string;
  ratio: number;
};

/** Word-aligned prefix. A word shows once playback reaches its start. */
export function revealTextPrefix(text: string, ratio: number): string {
  if (!(ratio > 0) || text.length === 0) return "";
  if (ratio >= 1) return text;
  const tokens = text.match(/\s+|\S+/g);
  if (!tokens) return "";
  let cursor = 0;
  let end = 0;
  let seenWord = false;
  for (const token of tokens) {
    const start = cursor;
    cursor += token.length;
    if (/^\s/.test(token)) continue;
    if (seenWord && start / text.length > ratio) break;
    seenWord = true;
    end = cursor;
  }
  return text.slice(0, end);
}

/** Playback position across spoken chunks, weighted by chunk length. */
export function speechProgress(input: {
  chunks: readonly string[];
  index: number;
  chunkRatio: number;
}): number {
  const total = input.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (total === 0) return 1;
  const before = input.chunks
    .slice(0, Math.max(0, input.index))
    .reduce((sum, chunk) => sum + chunk.length, 0);
  const current = input.chunks[input.index]?.length ?? 0;
  const ratio = Math.min(1, Math.max(0, input.chunkRatio));
  return Math.min(1, (before + current * ratio) / total);
}
