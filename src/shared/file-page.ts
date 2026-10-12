export type FilePageItem = {
  path: string;
  type: string;
  size: number | null;
  snippet?: string;
};

export type FilePageView = {
  summary: string;
  items: FilePageItem[];
  nextCursor: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readItem(value: unknown): FilePageItem | null {
  const row = asRecord(value);
  if (!row || typeof row.path !== "string" || row.path.length === 0)
    return null;
  const type = typeof row.type === "string" ? row.type : "file";
  const size = typeof row.size === "number" ? row.size : null;
  const snippet = typeof row.snippet === "string" ? row.snippet : undefined;
  return snippet
    ? { path: row.path, type, size, snippet }
    : { path: row.path, type, size };
}

/** A file list or search page. Other action payloads stay ordinary text. */
export function readFilePage(result: unknown): FilePageView | null {
  const parsed = typeof result === "string" ? parseJson(result) : result;
  const action = asRecord(parsed);
  if (!action) return null;
  const detailValue =
    typeof action.detail === "string"
      ? parseJson(action.detail)
      : action.detail;
  const detail = asRecord(detailValue);
  if (!detail || !Array.isArray(detail.items)) return null;
  const items = detail.items.flatMap((item) => {
    const row = readItem(item);
    return row ? [row] : [];
  });
  if (items.length !== detail.items.length || items.length === 0) return null;
  const page = asRecord(detail.page);
  const nextCursor =
    page && typeof page.nextCursor === "string" ? page.nextCursor : null;
  const summary = typeof action.summary === "string" ? action.summary : "";
  return { summary, items, nextCursor };
}
