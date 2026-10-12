import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { win32 } from "node:path";
import type { InstalledProgram, SoftwareHit } from "../../shared/software";
import { safeProgramToken } from "../../shared/software";
import { readInstalledPrograms } from "../platform/win-registry";

export type SoftwareRead = {
  programs: InstalledProgram[];
  complete: boolean;
};

export type SoftwareSource = {
  platform: NodeJS.Platform;
  installed: () => SoftwareRead;
  locate: (token: string) => SoftwareHit[];
};

const CACHE_MS = 60_000;

let cache: {
  source: SoftwareSource;
  at: number;
  read: SoftwareRead;
} | null = null;

export function clearSoftwareCache(): void {
  cache = null;
}

function load(source: SoftwareSource, now: number): SoftwareRead {
  if (cache && cache.source === source && now - cache.at < CACHE_MS) {
    return cache.read;
  }
  const read = source.installed();
  cache = { source, at: now, read };
  return read;
}

export function unsupportedSoftware(): boolean {
  return process.platform !== "win32";
}

function pageCursor(fingerprint: string, offset: number): string {
  return Buffer.from(`${fingerprint}:${offset}`, "utf8").toString("base64url");
}

function readCursor(
  cursor: string,
): { fingerprint: string; offset: number } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const split = decoded.lastIndexOf(":");
    if (split <= 0) return null;
    const fingerprint = decoded.slice(0, split);
    const offset = Number(decoded.slice(split + 1));
    if (!/^[0-9a-f]{12}$/u.test(fingerprint)) return null;
    if (!Number.isInteger(offset) || offset < 0) return null;
    return { fingerprint, offset };
  } catch {
    return null;
  }
}

function fingerprintOf(programs: readonly InstalledProgram[]): string {
  return createHash("sha256")
    .update(programs.map((item) => item.name).join("\n"))
    .digest("hex")
    .slice(0, 12);
}

export function listSoftwarePage(input: {
  source: SoftwareSource;
  pageSize: number;
  cursor?: string;
  now?: number;
}):
  | {
      ok: true;
      programs: InstalledProgram[];
      offset: number;
      total: number;
      complete: boolean;
      nextCursor?: string;
    }
  | { ok: false; code: "stale_cursor" | "invalid_cursor" | "unsupported_platform"; summary: string } {
  if (input.source.platform !== "win32") {
    return {
      ok: false,
      code: "unsupported_platform",
      summary: "Installed-program inventory is available on Windows only.",
    };
  }
  const read = load(input.source, input.now ?? Date.now());
  const fingerprint = fingerprintOf(read.programs);
  let offset = 0;
  if (input.cursor) {
    const parsed = readCursor(input.cursor);
    if (!parsed) {
      return {
        ok: false,
        code: "invalid_cursor",
        summary: "That software page cursor is not valid.",
      };
    }
    if (parsed.fingerprint !== fingerprint) {
      return {
        ok: false,
        code: "stale_cursor",
        summary: "The installed-program list changed. Start again.",
      };
    }
    offset = parsed.offset;
  }
  const programs = read.programs.slice(offset, offset + input.pageSize);
  const next = offset + programs.length;
  return {
    ok: true,
    programs,
    offset,
    total: read.programs.length,
    complete: read.complete,
    ...(next < read.programs.length
      ? { nextCursor: pageCursor(fingerprint, next) }
      : {}),
  };
}

export function findSoftware(input: {
  source: SoftwareSource;
  name: string;
  now?: number;
}):
  | { ok: true; token: string; matches: SoftwareHit[] }
  | { ok: false; code: string; summary: string } {
  if (input.source.platform !== "win32") {
    return {
      ok: false,
      code: "unsupported_platform",
      summary: "Program lookup is available on Windows only.",
    };
  }
  const token = safeProgramToken(input.name);
  if (!token) {
    return {
      ok: false,
      code: "invalid_args",
      summary: "Use a program name, not a path or a command.",
    };
  }
  const read = load(input.source, input.now ?? Date.now());
  const needle = token.toLowerCase();
  const fromRegistry: SoftwareHit[] = read.programs
    .filter((program) => program.name.toLowerCase().includes(needle))
    .slice(0, 10)
    .map((program) => ({
      source: "registry" as const,
      name: program.name,
      version: program.version,
      path: program.location,
    }));
  const fromDisk = input.source.locate(token).slice(0, 5);
  const matches = [...fromRegistry, ...fromDisk].slice(0, 15);
  return { ok: true, token, matches };
}

function safePathEntry(entry: string): string | null {
  const trimmed = entry.trim().replace(/^"|"$/gu, "");
  if (!trimmed || !win32.isAbsolute(trimmed)) return null;
  if (/[&|<>"]/u.test(trimmed)) return null;
  if (trimmed.split(/[\\/]+/u).includes("..")) return null;
  return trimmed;
}

export function locateProgramFiles(input: {
  token: string;
  pathEntries: readonly string[];
  knownRoots: readonly string[];
  exists: (candidate: string) => boolean;
}): SoftwareHit[] {
  const hits: SoftwareHit[] = [];
  const seen = new Set<string>();
  const add = (source: SoftwareHit["source"], candidate: string): void => {
    const key = candidate.toLowerCase();
    if (seen.has(key) || !input.exists(candidate)) return;
    seen.add(key);
    hits.push({
      source,
      name: input.token,
      version: "",
      path: candidate,
    });
  };
  for (const entry of input.pathEntries) {
    const directory = safePathEntry(entry);
    if (!directory) continue;
    add("path", win32.join(directory, `${input.token}.exe`));
  }
  for (const root of input.knownRoots) {
    const directory = safePathEntry(root);
    if (!directory) continue;
    add("known", win32.join(directory, `${input.token}.exe`));
    add("known", win32.join(directory, input.token, `${input.token}.exe`));
  }
  return hits;
}

function fileExists(candidate: string): boolean {
  try {
    return lstatSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function windowsSoftwareSource(): SoftwareSource {
  return {
    platform: "win32",
    installed: () => readInstalledPrograms(),
    locate: (token) =>
      locateProgramFiles({
        token,
        pathEntries: (process.env.PATH ?? "").split(";"),
        knownRoots: [
          process.env.ProgramFiles ?? "",
          process.env["ProgramFiles(x86)"] ?? "",
          process.env.LOCALAPPDATA ?? "",
        ],
        exists: fileExists,
      }),
  };
}
