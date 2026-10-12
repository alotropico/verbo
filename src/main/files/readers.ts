import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { win32 } from "node:path";
import type { ActionResult } from "../../shared/action-contract";
import { FILE_QUERY_LIMITS, TEXT_EXTENSIONS } from "../../shared/file-query";
import {
  FILE_READER_LIMITS,
  filesCompareArgsSchema,
  filesHashArgsSchema,
  filesInspectImageArgsSchema,
  filesReadArgsSchema,
  type FilesCompareArgs,
  type FilesReadArgs,
} from "../../shared/file-readers";
import type { FileQueryRequest } from "./query-engine";
import { readImageMeta } from "./image-meta";
import { resolveFileReference } from "./path-policy";
import { extractPdfText } from "./pdf-text";
import { windowsFileFlags } from "./windows-containment";

const TEXT = new Set<string>(TEXT_EXTENSIONS);

type Opened =
  | {
      ok: true;
      display: string;
      absolute: string;
      size: number;
    }
  | { ok: false; result: ActionResult };

function failure(action: string, code: string, summary: string): ActionResult {
  return { action, status: "error", code, summary };
}

function extensionOf(display: string): string {
  const base = win32.basename(display);
  if (base.startsWith(".") && !base.slice(1).includes(".")) return "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function pack(body: Record<string, unknown>): {
  detail: string;
  truncated: boolean;
} {
  let truncated = body.truncated === true;
  let detail = JSON.stringify(body);
  while (
    detail.length > FILE_QUERY_LIMITS.detailBudget &&
    typeof body.text === "string" &&
    body.text.length > 0
  ) {
    truncated = true;
    body.truncated = true;
    body.text = body.text.slice(0, Math.floor(body.text.length * 0.8));
    detail = JSON.stringify(body);
  }
  if (detail.length > FILE_QUERY_LIMITS.detailBudget) {
    return {
      detail: JSON.stringify({ truncated: true, omitted: true }),
      truncated: true,
    };
  }
  return { detail, truncated };
}

function openFile(request: FileQueryRequest, action: string, reference: string): Opened {
  const resolved = resolveFileReference({
    reference,
    purpose: "read",
    actor: request.actor,
    scopes: request.store.list(),
    grants: request.store.activeGrants(),
    ...(request.now !== undefined ? { now: request.now } : {}),
  });
  if (!resolved.ok) {
    return { ok: false, result: failure(action, resolved.code, resolved.summary) };
  }
  let stats;
  try {
    stats = lstatSync(resolved.path.absolute);
  } catch {
    return {
      ok: false,
      result: failure(action, "missing", "That path does not exist."),
    };
  }
  const flags = windowsFileFlags(resolved.path.absolute);
  if (stats.isSymbolicLink() || flags?.reparse) {
    return {
      ok: false,
      result: failure(action, "link", "Links are not read. Open the target path."),
    };
  }
  if (!stats.isFile()) {
    return {
      ok: false,
      result: failure(action, "not_a_file", "That path is not a file."),
    };
  }
  return {
    ok: true,
    display: resolved.path.display,
    absolute: resolved.path.absolute,
    size: stats.size,
  };
}

function readPrefix(
  absolute: string,
  size: number,
  maxBytes: number,
): Buffer {
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(absolute, "r");
  try {
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function decodeText(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  const source = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    ? buffer.subarray(3)
    : buffer;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    return null;
  }
}

function pointerValue(
  value: unknown,
  pointer: string,
): { ok: true; value: unknown } | { ok: false } {
  if (pointer === "") return { ok: true, value };
  if (!pointer.startsWith("/")) return { ok: false };
  let current = value;
  for (const part of pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/gu, "/").replace(/~0/gu, "~"))) {
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(part)) return { ok: false };
      const index = Number(part);
      if (index >= current.length) return { ok: false };
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) {
      return { ok: false };
    }
    current = (current as Record<string, unknown>)[part];
  }
  return { ok: true, value: current };
}

function textLines(
  action: string,
  opened: Extract<Opened, { ok: true }>,
  args: FilesReadArgs,
): ActionResult {
  const buffer = readPrefix(
    opened.absolute,
    opened.size,
    FILE_READER_LIMITS.maxReadBytes,
  );
  const text = decodeText(buffer);
  if (text === null) {
    return {
      action,
      status: "not_supported",
      code: "unsupported_encoding",
      summary: "That file is not UTF-8 text.",
    };
  }
  const lines = text.split(/\r?\n/u);
  const start = args.startLine;
  if (start > lines.length) {
    return failure(action, "line_missing", `That file has ${lines.length} lines.`);
  }
  const slice = lines.slice(start - 1, start - 1 + args.lineCount);
  const endLine = start - 1 + slice.length;
  const byteCapped = opened.size > buffer.length;
  const moreLines = endLine < lines.length || byteCapped;
  const body: Record<string, unknown> = {
    path: opened.display,
    mode: "text",
    encoding: "utf-8",
    bytes: opened.size,
    startLine: start,
    endLine,
    truncated: byteCapped,
    ...(moreLines ? { next: { startLine: endLine + 1 } } : {}),
    text: slice.join("\n"),
  };
  const packed = pack(body);
  return {
    action,
    status: byteCapped || packed.truncated ? "partial" : "success",
    ...(byteCapped || packed.truncated ? { code: "limit_reached" } : {}),
    summary: moreLines
      ? `Read lines ${start}–${endLine}. More lines remain.`
      : `Read lines ${start}–${endLine}.`,
    detail: packed.detail,
  };
}

function jsonText(
  action: string,
  opened: Extract<Opened, { ok: true }>,
  pointer?: string,
): ActionResult {
  if (opened.size > FILE_READER_LIMITS.maxReadBytes) {
    return {
      action,
      status: "partial",
      code: "limit_reached",
      summary: "That JSON file is larger than the read cap.",
    };
  }
  const text = decodeText(readPrefix(opened.absolute, opened.size, opened.size));
  if (text === null) {
    return {
      action,
      status: "not_supported",
      code: "unsupported_encoding",
      summary: "That JSON file is not UTF-8.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return failure(action, "invalid_json", "That file is not valid JSON.");
  }
  const selected = pointerValue(parsed, pointer ?? "");
  if (!selected.ok) {
    return failure(action, "pointer_missing", "That JSON pointer was not found.");
  }
  const body: Record<string, unknown> = {
    path: opened.display,
    mode: "json",
    bytes: opened.size,
    ...(pointer ? { pointer } : {}),
    text: JSON.stringify(selected.value),
  };
  const packed = pack(body);
  return {
    action,
    status: packed.truncated ? "partial" : "success",
    ...(packed.truncated ? { code: "limit_reached" } : {}),
    summary: packed.truncated
      ? "Read part of the JSON value."
      : "Read the JSON value.",
    detail: packed.detail,
  };
}

function pdfText(
  action: string,
  opened: Extract<Opened, { ok: true }>,
  args: FilesReadArgs,
): ActionResult {
  if (opened.size > FILE_READER_LIMITS.maxReadBytes) {
    return {
      action,
      status: "partial",
      code: "limit_reached",
      summary: "That PDF is larger than the read cap.",
    };
  }
  const extracted = extractPdfText(
    readPrefix(opened.absolute, opened.size, opened.size),
    { page: args.page, pageCount: args.pageCount },
  );
  if (!extracted.ok) {
    const status = extracted.code === "page_missing" ? "error" : "not_supported";
    return { action, status, code: extracted.code, summary: extracted.summary };
  }
  const imageOnly =
    extracted.pages.length > 0 && extracted.pages.every((page) => page.imageOnly);
  const nextPage = args.page + extracted.pages.length;
  const body: Record<string, unknown> = {
    path: opened.display,
    mode: "pdf",
    bytes: opened.size,
    pageCount: extracted.pageCount,
    pages: extracted.pages.map((page) => ({
      page: page.page,
      imageOnly: page.imageOnly,
      text: page.text.slice(0, FILE_READER_LIMITS.maxReturnedChars),
    })),
    ...(extracted.warnings.length > 0 ? { warnings: extracted.warnings } : {}),
    ...(nextPage <= extracted.pageCount ? { next: { page: nextPage } } : {}),
  };
  let detail = JSON.stringify(body);
  let truncated = false;
  const pages = body.pages as Array<{ text: string }>;
  while (detail.length > FILE_QUERY_LIMITS.detailBudget) {
    const page = pages.find((item) => item.text.length > 40);
    if (!page) break;
    truncated = true;
    page.text = page.text.slice(0, Math.floor(page.text.length * 0.7));
    detail = JSON.stringify(body);
  }
  if (detail.length > FILE_QUERY_LIMITS.detailBudget) {
    detail = JSON.stringify({
      path: opened.display,
      mode: "pdf",
      truncated: true,
      pageCount: extracted.pageCount,
    });
    truncated = true;
  }
  return {
    action,
    status:
      imageOnly || extracted.warnings.length > 0 || truncated
        ? "partial"
        : "success",
    ...(imageOnly
      ? { code: "image_only" }
      : extracted.warnings.length > 0
        ? { code: "unsupported_filter" }
        : truncated
          ? { code: "limit_reached" }
          : {}),
    summary: imageOnly
      ? "Those PDF pages have no extractable text."
      : `Read ${extracted.pages.length} PDF page${extracted.pages.length === 1 ? "" : "s"}.`,
    detail,
  };
}

export function readFileContent(
  request: FileQueryRequest,
  args: unknown,
): ActionResult {
  const parsed = filesReadArgsSchema.safeParse(args);
  if (!parsed.success) {
    return failure("files.read", "invalid_args", "Those read arguments are not valid.");
  }
  const opened = openFile(request, "files.read", parsed.data.path);
  if (!opened.ok) return opened.result;
  const extension = extensionOf(opened.display);
  const mode =
    parsed.data.mode === "auto"
      ? extension === "json"
        ? "json"
        : extension === "pdf"
          ? "pdf"
          : "text"
      : parsed.data.mode;
  if (mode === "text" && extension !== "" && !TEXT.has(extension) && extension !== "pdf") {
    if (parsed.data.mode === "auto") {
      return {
        action: "files.read",
        status: "not_supported",
        code: "unsupported_format",
        summary: "That file is not a supported text, JSON, or PDF document.",
      };
    }
  }
  if (parsed.data.pointer && mode !== "json") {
    return failure(
      "files.read",
      "invalid_args",
      "JSON pointers apply to JSON files.",
    );
  }
  if (mode === "json") return jsonText("files.read", opened, parsed.data.pointer);
  if (mode === "pdf") return pdfText("files.read", opened, parsed.data);
  return textLines("files.read", opened, parsed.data);
}

function lineDiff(left: string[], right: string[]): string[] {
  const rows = left.length;
  const columns = right.length;
  const scores = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      scores[row]![column] =
        left[row] === right[column]
          ? (scores[row + 1]?.[column + 1] ?? 0) + 1
          : Math.max(scores[row + 1]?.[column] ?? 0, scores[row]?.[column + 1] ?? 0);
    }
  }
  const lines: string[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (left[row] === right[column]) {
      row += 1;
      column += 1;
      continue;
    }
    if ((scores[row + 1]?.[column] ?? 0) >= (scores[row]?.[column + 1] ?? 0)) {
      lines.push(`-${left[row] ?? ""}`);
      row += 1;
    } else {
      lines.push(`+${right[column] ?? ""}`);
      column += 1;
    }
  }
  while (row < rows) lines.push(`-${left[row++] ?? ""}`);
  while (column < columns) lines.push(`+${right[column++] ?? ""}`);
  return lines;
}

function readComparable(
  request: FileQueryRequest,
  reference: string,
): { ok: true; display: string; text: string; capped: boolean } | { ok: false; result: ActionResult } {
  const opened = openFile(request, "files.compare", reference);
  if (!opened.ok) return opened;
  const buffer = readPrefix(
    opened.absolute,
    opened.size,
    FILE_READER_LIMITS.maxReadBytes,
  );
  const text = decodeText(buffer);
  if (text === null) {
    return {
      ok: false,
      result: {
        action: "files.compare",
        status: "not_supported",
        code: "unsupported_encoding",
        summary: "Compare reads UTF-8 text only.",
      },
    };
  }
  return {
    ok: true,
    display: opened.display,
    text,
    capped: opened.size > buffer.length,
  };
}

export function compareFiles(
  request: FileQueryRequest,
  args: unknown,
): ActionResult {
  const parsed = filesCompareArgsSchema.safeParse(args);
  if (!parsed.success) {
    return failure(
      "files.compare",
      "invalid_args",
      "Compare one file with a second path or with proposed text.",
    );
  }
  const data: FilesCompareArgs = parsed.data;
  const left = readComparable(request, data.left);
  if (!left.ok) return left.result;
  let rightText = data.proposed ?? "";
  let rightLabel = "proposed";
  let capped = left.capped;
  if (data.right) {
    const right = readComparable(request, data.right);
    if (!right.ok) return right.result;
    rightText = right.text;
    rightLabel = right.display;
    capped = capped || right.capped;
  }
  const leftLines = left.text.split(/\r?\n/u);
  const rightLines = rightText.split(/\r?\n/u);
  const lineCapped =
    leftLines.length > FILE_READER_LIMITS.maxCompareLines ||
    rightLines.length > FILE_READER_LIMITS.maxCompareLines;
  const diff = lineDiff(
    leftLines.slice(0, FILE_READER_LIMITS.maxCompareLines),
    rightLines.slice(0, FILE_READER_LIMITS.maxCompareLines),
  );
  if (diff.length === 0 && !capped && !lineCapped) {
    return {
      action: "files.compare",
      status: "success",
      summary: "Those texts match.",
      detail: JSON.stringify({
        left: left.display,
        right: rightLabel,
        match: true,
      }),
    };
  }
  const body: Record<string, unknown> = {
    left: left.display,
    right: rightLabel,
    match: false,
    truncated: capped || lineCapped,
    text: diff.join("\n"),
  };
  const packed = pack(body);
  const limited = capped || lineCapped || packed.truncated;
  return {
    action: "files.compare",
    status: limited ? "partial" : "success",
    ...(limited ? { code: "limit_reached" } : {}),
    summary: limited
      ? "Compared the files up to the diff cap."
      : `Found ${diff.length} changed lines.`,
    detail: packed.detail,
  };
}

export function hashFiles(
  request: FileQueryRequest,
  args: unknown,
): ActionResult {
  const parsed = filesHashArgsSchema.safeParse(args);
  if (!parsed.success) {
    return failure("files.hash", "invalid_args", "Hash needs one or more paths.");
  }
  const items: Array<{ path: string; algorithm: "sha256"; sha256: string; bytes: number }> = [];
  const errors: Array<{ path: string; code: string; summary: string }> = [];
  for (const reference of parsed.data.paths) {
    const opened = openFile(request, "files.hash", reference);
    if (!opened.ok) {
      errors.push({
        path: reference,
        code: opened.result.code ?? "error",
        summary: opened.result.summary,
      });
      continue;
    }
    if (opened.size > FILE_READER_LIMITS.maxHashBytes) {
      errors.push({
        path: reference,
        code: "limit_reached",
        summary: "That file is larger than the hash cap.",
      });
      continue;
    }
    const hash = createHash("sha256");
    const fd = openSync(opened.absolute, "r");
    try {
      const chunk = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < opened.size) {
        const read = readSync(fd, chunk, 0, chunk.length, offset);
        if (read === 0) break;
        hash.update(chunk.subarray(0, read));
        offset += read;
      }
    } finally {
      closeSync(fd);
    }
    items.push({
      path: opened.display,
      algorithm: "sha256",
      sha256: hash.digest("hex"),
      bytes: opened.size,
    });
  }
  if (items.length === 0) {
    return failure(
      "files.hash",
      errors[0]?.code ?? "missing",
      errors[0]?.summary ?? "Those files could not be hashed.",
    );
  }
  return {
    action: "files.hash",
    status: errors.length > 0 ? "partial" : "success",
    ...(errors.length > 0 ? { code: "partial_hash" } : {}),
    summary:
      errors.length > 0
        ? `Hashed ${items.length} files. ${errors.length} failed.`
        : `Hashed ${items.length} files.`,
    detail: JSON.stringify({ items, errors }),
    totalItems: items.length,
  };
}

export function inspectImages(
  request: FileQueryRequest,
  args: unknown,
  options?: { visionSupported?: boolean },
): ActionResult {
  const parsed = filesInspectImageArgsSchema.safeParse(args);
  if (!parsed.success) {
    return failure(
      "files.inspect_image",
      "invalid_args",
      "Image inspection needs one or more paths.",
    );
  }
  const vision = options?.visionSupported === true;
  const items: Record<string, unknown>[] = [];
  const errors: Array<{ path: string; code: string; summary: string }> = [];
  let omittedPayload = false;
  for (const reference of parsed.data.paths) {
    const opened = openFile(request, "files.inspect_image", reference);
    if (!opened.ok) {
      errors.push({
        path: reference,
        code: opened.result.code ?? "error",
        summary: opened.result.summary,
      });
      continue;
    }
    const buffer = readPrefix(
      opened.absolute,
      opened.size,
      Math.min(opened.size, FILE_READER_LIMITS.maxImageScanBytes),
    );
    const meta = readImageMeta(buffer);
    if (!meta) {
      errors.push({
        path: reference,
        code: "unsupported_image",
        summary: "That image format is not supported.",
      });
      continue;
    }
    const item: Record<string, unknown> = {
      path: opened.display,
      format: meta.format,
      width: meta.width,
      height: meta.height,
      bytes: opened.size,
    };
    if (parsed.data.includePayload) {
      if (!vision) {
        omittedPayload = true;
        item.payload = "vision_unavailable";
      } else if (opened.size > FILE_READER_LIMITS.maxPayloadBytes || opened.size !== buffer.length) {
        omittedPayload = true;
        item.payload = "capped";
      } else {
        item.payload = "inline";
        item.mediaType =
          meta.format === "jpeg" ? "image/jpeg" : `image/${meta.format}`;
        item.dataUrl = `data:${String(item.mediaType)};base64,${buffer.toString("base64")}`;
      }
    }
    items.push(item);
  }
  if (items.length === 0) {
    return {
      action: "files.inspect_image",
      status: "not_supported",
      code: errors[0]?.code ?? "unsupported_image",
      summary: errors[0]?.summary ?? "Those images could not be read.",
    };
  }
  let detail = JSON.stringify({ items, errors });
  if (detail.length > FILE_QUERY_LIMITS.detailBudget) {
    for (const item of items) {
      delete item.dataUrl;
      if (item.payload === "inline") item.payload = "capped";
    }
    omittedPayload = true;
    detail = JSON.stringify({ items, errors });
  }
  return {
    action: "files.inspect_image",
    status: errors.length > 0 || omittedPayload ? "partial" : "success",
    ...(omittedPayload
      ? { code: vision ? "payload_capped" : "vision_unavailable" }
      : errors.length > 0
        ? { code: "partial_image" }
        : {}),
    summary: omittedPayload
      ? `Read metadata for ${items.length} images. The image bytes were not included.`
      : `Read metadata for ${items.length} images.`,
    detail,
    totalItems: items.length,
  };
}
