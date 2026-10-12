import { inflateSync } from "node:zlib";

export type PdfPageText = {
  page: number;
  text: string;
  imageOnly: boolean;
};

export type PdfExtract =
  | {
      ok: true;
      pageCount: number;
      pages: PdfPageText[];
      warnings: string[];
    }
  | { ok: false; code: string; summary: string };

type PdfObject = {
  id: number;
  header: string;
  stream: Buffer | null;
  undecoded: boolean;
};

function boundary(byte: number | undefined): boolean {
  return (
    byte === undefined ||
    byte === 32 ||
    byte === 9 ||
    byte === 10 ||
    byte === 13 ||
    byte === 47 ||
    byte === 60 ||
    byte === 62 ||
    byte === 91 ||
    byte === 93
  );
}

function indexOfWord(buffer: Buffer, word: string, from: number): number {
  let cursor = from;
  while (cursor < buffer.length) {
    const at = buffer.indexOf(word, cursor);
    if (at < 0) return -1;
    if (
      boundary(buffer[at - 1]) &&
      boundary(buffer[at + word.length])
    ) {
      return at;
    }
    cursor = at + word.length;
  }
  return -1;
}

function afterStreamKeyword(buffer: Buffer, streamAt: number): number {
  const cursor = streamAt + "stream".length;
  if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) return cursor + 2;
  if (buffer[cursor] === 10 || buffer[cursor] === 13) return cursor + 1;
  return cursor;
}

function directLength(header: string): number | null {
  const match = /\/Length\s+(\d+)/u.exec(header);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function decodeStream(header: string, data: Buffer): Buffer | null {
  const filters = [...header.matchAll(/\/([A-Za-z0-9]+Decode)/gu)].map(
    (item) => item[1],
  );
  if (filters.length === 0) return Buffer.from(data);
  if (filters.length === 1 && filters[0] === "FlateDecode") {
    try {
      return inflateSync(data);
    } catch {
      return null;
    }
  }
  return null;
}

function parseObjects(buffer: Buffer): PdfObject[] {
  const objects: PdfObject[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const at = buffer.indexOf(" obj", cursor);
    if (at < 0) break;
    let start = at - 1;
    while (start >= 0 && buffer[start] !== 10 && buffer[start] !== 13) {
      start -= 1;
    }
    const prefix = buffer.subarray(start + 1, at).toString("latin1").trim();
    const match = /^(\d+)\s+\d+$/u.exec(prefix);
    if (!match?.[1]) {
      cursor = at + 4;
      continue;
    }
    const body = at + 4;
    const streamAt = indexOfWord(buffer, "stream", body);
    const endobjAt = indexOfWord(buffer, "endobj", body);
    if (endobjAt < 0) break;
    if (streamAt >= 0 && streamAt < endobjAt) {
      const header = buffer.subarray(body, streamAt).toString("latin1");
      const dataStart = afterStreamKeyword(buffer, streamAt);
      const length = directLength(header);
      let dataEnd = dataStart;
      if (length !== null && dataStart + length <= buffer.length) {
        dataEnd = dataStart + length;
      } else {
        const end = buffer.indexOf("endstream", dataStart);
        if (end < 0) break;
        dataEnd = end;
      }
      const encoded = buffer.subarray(dataStart, dataEnd);
      const stream = decodeStream(header, encoded);
      objects.push({
        id: Number(match[1]),
        header,
        stream,
        undecoded: stream === null && /\/Filter/u.test(header),
      });
      const next = buffer.indexOf("endobj", dataEnd);
      cursor = next < 0 ? buffer.length : next + "endobj".length;
      continue;
    }
    objects.push({
      id: Number(match[1]),
      header: buffer.subarray(body, endobjAt).toString("latin1"),
      stream: null,
      undecoded: false,
    });
    cursor = endobjAt + "endobj".length;
  }
  return objects;
}

function refList(source: string, key: string): number[] {
  const match = new RegExp(
    `/${key}\\s*(?:\\[([^\\]]*)\\]|(\\d+)\\s+\\d+\\s+R)`,
    "u",
  ).exec(source);
  if (!match) return [];
  const body = match[1] ?? `${match[2] ?? ""} 0 R`;
  return [...body.matchAll(/(\d+)\s+\d+\s+R/gu)]
    .map((item) => Number(item[1]))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function isPage(header: string): boolean {
  return /\/Type\s*\/Page\b/u.test(header) && !/\/Type\s*\/Pages\b/u.test(header);
}

function orderedPages(objects: Map<number, PdfObject>): PdfObject[] {
  const loose = [...objects.values()].filter((object) => isPage(object.header));
  const roots = [...objects.values()].filter((object) =>
    /\/Type\s*\/Pages\b/u.test(object.header),
  );
  if (roots.length === 0) return loose;
  const ordered: PdfObject[] = [];
  const seen = new Set<number>();
  const walk = (id: number, depth: number): void => {
    if (depth > 8 || seen.has(id)) return;
    seen.add(id);
    const object = objects.get(id);
    if (!object) return;
    if (isPage(object.header)) {
      ordered.push(object);
      return;
    }
    for (const kid of refList(object.header, "Kids")) walk(kid, depth + 1);
  };
  for (const root of roots) walk(root.id, 0);
  return ordered.length > 0 ? ordered : loose;
}

function readLiteral(
  source: string,
  start: number,
): { value: string; end: number } | null {
  if (source[start] !== "(") return null;
  let depth = 1;
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (char === "\\") {
      value += char + (source[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      value += char;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return { value, end: index + 1 };
      value += char;
      continue;
    }
    value += char;
  }
  return null;
}

function unescapePdf(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = value[index + 1];
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "(" || next === ")" || next === "\\") out += next;
    else if (next && /[0-7]/u.test(next)) {
      let octal = next;
      let cursor = index + 2;
      while (
        octal.length < 3 &&
        cursor < value.length &&
        /[0-7]/u.test(value[cursor] ?? "")
      ) {
        octal += value[cursor];
        cursor += 1;
      }
      out += String.fromCharCode(Number.parseInt(octal, 8));
      index = cursor - 1;
      continue;
    } else out += next ?? "";
    index += 1;
  }
  return out;
}

function extractOperators(content: string): string {
  const parts: string[] = [];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "(") continue;
    const literal = readLiteral(content, index);
    if (!literal) break;
    parts.push(unescapePdf(literal.value));
    index = literal.end - 1;
  }
  return parts.join("").replace(/[ \t]+\n/gu, "\n").trim();
}

function pageHasImage(
  page: PdfObject,
  objects: Map<number, PdfObject>,
  content: string,
): boolean {
  if (/\/Subtype\s*\/Image\b/u.test(page.header) || /\bDo\b/u.test(content)) {
    return true;
  }
  const ids = [...page.header.matchAll(/(\d+)\s+\d+\s+R/gu)].map((item) =>
    Number(item[1]),
  );
  return ids.some((id) => {
    const object = objects.get(id);
    return object ? /\/Subtype\s*\/Image\b/u.test(object.header) : false;
  });
}

/** Bounded PDF text. Unknown filters and encryption stay explicit. */
export function extractPdfText(
  buffer: Buffer,
  range: { page: number; pageCount: number },
): PdfExtract {
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return {
      ok: false,
      code: "unsupported_format",
      summary: "That file is not a PDF.",
    };
  }
  if (buffer.includes(Buffer.from("/Encrypt"))) {
    return {
      ok: false,
      code: "encrypted",
      summary: "Encrypted PDFs are not read.",
    };
  }
  const objects = new Map(
    parseObjects(buffer).map((object) => [object.id, object]),
  );
  const pages = orderedPages(objects);
  if (pages.length === 0) {
    return {
      ok: false,
      code: "pdf_unreadable",
      summary: "That PDF has no readable pages.",
    };
  }
  const start = range.page;
  const selected = pages.slice(start - 1, start - 1 + range.pageCount);
  if (selected.length === 0) {
    return {
      ok: false,
      code: "page_missing",
      summary: `That PDF has ${pages.length} pages.`,
    };
  }
  const warnings: string[] = [];
  const extracted = selected.map((page, index) => {
    const contentIds = refList(page.header, "Contents");
    const chunks: string[] = [];
    for (const id of contentIds) {
      const object = objects.get(id);
      if (!object) continue;
      if (object.undecoded || (object.stream === null && /\/Filter/u.test(object.header))) {
        warnings.push(`Page ${start + index} used an unsupported filter.`);
        continue;
      }
      if (object.stream) chunks.push(object.stream.toString("latin1"));
    }
    const content = chunks.join("\n");
    const text = extractOperators(content);
    return {
      page: start + index,
      text,
      imageOnly: text.length === 0 && pageHasImage(page, objects, content),
    };
  });
  return { ok: true, pageCount: pages.length, pages: extracted, warnings };
}
