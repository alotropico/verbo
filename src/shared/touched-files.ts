const touchActions = new Set([
  "files.create",
  "files.edit",
  "files.move",
  "files.rename",
  "files.batch",
]);

const pathField = {
  create_file: "to",
  edit: "from",
  move: "to",
  rename: "to",
} as const;

export type TouchedFile = {
  path: string;
  name: string;
};

export type TouchedFileReview = {
  operationId: string;
  threadId: string;
};

export type TouchedFileScan = {
  files: TouchedFile[];
  reviews: TouchedFileReview[];
};

function recordOf(value: unknown): Record<string, unknown> | null {
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

export function touchedFileName(path: string): string {
  const leaf = path.split(/[/\\]/u).findLast((part) => part.length > 0);
  return leaf ?? path;
}

export function touchedFilesFromItems(items: unknown): TouchedFile[] {
  if (!Array.isArray(items)) return [];
  const files: TouchedFile[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const record = recordOf(item);
    if (!record || record.status !== "succeeded") continue;
    const kind = record.kind;
    if (typeof kind !== "string" || !(kind in pathField)) continue;
    const field = pathField[kind as keyof typeof pathField];
    const path = record[field];
    if (typeof path !== "string" || path.length === 0 || seen.has(path))
      continue;
    seen.add(path);
    files.push({ path, name: touchedFileName(path) });
  }
  return files;
}

function scanAction(result: unknown): TouchedFileScan {
  const record = recordOf(
    typeof result === "string" ? parseJson(result) : result,
  );
  if (!record) return { files: [], reviews: [] };
  const action = record.action;
  const status = record.status;
  if (typeof action !== "string" || !touchActions.has(action)) {
    return { files: [], reviews: [] };
  }
  if (status !== "success" && status !== "partial") {
    return { files: [], reviews: [] };
  }
  const detail = recordOf(
    typeof record.detail === "string" ? parseJson(record.detail) : null,
  );
  const files = touchedFilesFromItems(detail?.items);
  const operationId = detail?.operationId;
  const threadId = detail?.threadId;
  const reviews =
    record.detailsAvailable === true &&
    typeof operationId === "string" &&
    typeof threadId === "string"
      ? [{ operationId, threadId }]
      : [];
  return { files, reviews };
}

export function touchedFilesFromParts(
  parts: readonly unknown[],
): TouchedFileScan {
  const files: TouchedFile[] = [];
  const reviews: TouchedFileReview[] = [];
  const seen = new Set<string>();
  const seenReviews = new Set<string>();
  for (const part of parts) {
    const record = recordOf(part);
    if (!record || record.type !== "tool-call") continue;
    const scan = scanAction(record.result);
    for (const file of scan.files) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      files.push(file);
    }
    for (const review of scan.reviews) {
      if (seenReviews.has(review.operationId)) continue;
      seenReviews.add(review.operationId);
      reviews.push(review);
    }
  }
  return { files, reviews };
}
