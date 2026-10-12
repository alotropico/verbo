export const LOCAL_THREAD_ID_PREFIX = "__LOCALID_";

const PLACEHOLDER_GLYPHS = "§¤¶†‡•◦∙∞≈≠±×÷√∆∑∏∫∴⋆";
const PLACEHOLDER_GLYPH_COUNT = 5;

export const TITLE_SYSTEM_PROMPT =
  "Reply with a chat title only. At most 3 words. At most 24 characters. No quotes. No explanation.";

function placeholderSeed(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function chatPlaceholderTitle(id: string): string {
  const source = id.startsWith(LOCAL_THREAD_ID_PREFIX)
    ? id.slice(LOCAL_THREAD_ID_PREFIX.length)
    : id;
  let seed = placeholderSeed(source);
  let title = "";
  for (let index = 0; index < PLACEHOLDER_GLYPH_COUNT; index += 1) {
    title += PLACEHOLDER_GLYPHS[seed % PLACEHOLDER_GLYPHS.length];
    seed = Math.imul(seed ^ (index + 1), 0x01000193) >>> 0;
  }
  return title;
}

export function sanitizeGeneratedTitle(raw: string): string | undefined {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  text = text.replace(/^["'`]+|["'`]+$/g, "").trim();
  text = text.replace(/^(title|name)\s*:\s*/i, "").trim();
  const words = text.split(/\s+/).filter((word) => word.length > 0).slice(0, 3);
  let title = "";
  for (const word of words) {
    const next = title.length > 0 ? `${title} ${word}` : word;
    if (next.length > 24) break;
    title = next;
  }
  if (!title && words[0]) title = words[0].slice(0, 24);
  if (!title) return undefined;
  return title;
}
