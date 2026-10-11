import koffi from "koffi";
import { win32 } from "node:path";

const GENERIC_READ = 0x80000000;
const SHARE_ALL = 0x1 | 0x2 | 0x4;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;

const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;

const kernel32 = koffi.load("kernel32.dll");
const CreateFileW = kernel32.func(
  "void* __stdcall CreateFileW(str16 lpFileName, uint32 dwDesiredAccess, uint32 dwShareMode, void* lpSecurityAttributes, uint32 dwCreationDisposition, uint32 dwFlagsAndAttributes, void* hTemplateFile)",
);
const CloseHandle = kernel32.func("bool __stdcall CloseHandle(void* hObject)");
const GetFinalPathNameByHandleW = kernel32.func(
  "uint32 __stdcall GetFinalPathNameByHandleW(void* hFile, _Out_ uint16_t *lpFilePath, uint32 cchFilePath, uint32 dwFlags)",
);
const GetLastError = kernel32.func("uint32 __stdcall GetLastError()");
const GetFileAttributesW = kernel32.func(
  "uint32 __stdcall GetFileAttributesW(str16 lpFileName)",
);

export type ContainmentCode =
  "outside" | "device" | "unc" | "invalid" | "root" | "unopenable";

export type ContainmentResult =
  | { ok: true; exists: true; finalPath: string }
  | { ok: true; exists: false; finalParent: string; leaf: string }
  | { ok: false; code: ContainmentCode };

type OpenedPath = { handle: bigint; finalPath: string };

function isInvalidHandle(handle: unknown): boolean {
  return typeof handle !== "bigint" || handle === 0n || handle === -1n;
}

function finalPathOf(handle: bigint): string | null {
  const characters = Buffer.alloc(4096);
  const length = GetFinalPathNameByHandleW(
    handle,
    characters,
    2048,
    0,
  ) as number;
  if (!length || length >= 2048) return null;
  return characters.toString("utf16le", 0, length * 2).replace(/\0+$/u, "");
}

function openPath(
  filePath: string,
): OpenedPath | { missing: true } | { failed: true } {
  const handle = CreateFileW(
    filePath,
    GENERIC_READ,
    SHARE_ALL,
    null,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS,
    null,
  );
  if (isInvalidHandle(handle)) {
    const error = GetLastError() as number;
    if (error === ERROR_FILE_NOT_FOUND || error === ERROR_PATH_NOT_FOUND)
      return { missing: true };
    return { failed: true };
  }
  const opened = handle as bigint;
  const finalPath = finalPathOf(opened);
  if (!finalPath) {
    CloseHandle(opened);
    return { failed: true };
  }
  return { handle: opened, finalPath };
}

function closeOpened(opened: OpenedPath): void {
  CloseHandle(opened.handle);
}

function comparable(finalPath: string): string {
  return finalPath
    .replace(/^\\\\\?\\/u, "")
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}

export function isFinalPathInside(
  rootFinal: string,
  candidateFinal: string,
): boolean {
  const root = comparable(rootFinal);
  const candidate = comparable(candidateFinal);
  return candidate === root || candidate.startsWith(`${root}\\`);
}

function rejectSpecialPath(candidate: string): ContainmentCode | null {
  if (!candidate || candidate.includes("\0")) return "invalid";
  const trimmed = candidate.trim();
  if (
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/iu.test(win32.basename(trimmed))
  )
    return "device";
  if (trimmed.startsWith("\\\\.\\") || trimmed.startsWith("//./"))
    return "device";
  if (trimmed.startsWith("\\\\?\\UNC\\") || trimmed.startsWith("\\\\?\\unc\\"))
    return "unc";
  if (/^\\\\[^?]/.test(trimmed) || trimmed.startsWith("//")) return "unc";
  return null;
}

export function resolveContainedPath(
  rootDir: string,
  candidate: string,
  purpose: "read" | "write" = "read",
): ContainmentResult {
  const special = rejectSpecialPath(candidate);
  if (special) return { ok: false, code: special };
  const rootOpened = openPath(rootDir);
  if (!("handle" in rootOpened)) return { ok: false, code: "unopenable" };
  const rootFinal = rootOpened.finalPath;
  closeOpened(rootOpened);

  const normalized = win32.normalize(candidate);
  const lexicalRoot = win32.normalize(rootDir);
  if (
    !isFinalPathInside(lexicalRoot, normalized) &&
    !isFinalPathInside(rootFinal, normalized)
  ) {
    return { ok: false, code: "outside" };
  }

  const opened = openPath(candidate);
  if ("handle" in opened) {
    const inside = isFinalPathInside(rootFinal, opened.finalPath);
    const finalPath = opened.finalPath;
    closeOpened(opened);
    if (!inside) return { ok: false, code: "outside" };
    if (
      purpose === "write" &&
      comparable(finalPath) === comparable(rootFinal)
    ) {
      return { ok: false, code: "root" };
    }
    return { ok: true, exists: true, finalPath };
  }

  let parent = win32.dirname(normalized);
  const leafParts: string[] = [win32.basename(normalized)];
  while (
    parent &&
    comparable(parent) !==
      comparable(win32.parse(parent).root.replace(/\\$/u, ""))
  ) {
    const parentOpened = openPath(parent);
    if ("handle" in parentOpened) {
      const inside = isFinalPathInside(rootFinal, parentOpened.finalPath);
      const finalParent = parentOpened.finalPath;
      closeOpened(parentOpened);
      if (!inside) return { ok: false, code: "outside" };
      if (
        leafParts.some(
          (part) => part === ".." || part === "." || part.includes(":"),
        )
      ) {
        return { ok: false, code: "invalid" };
      }
      return {
        ok: true,
        exists: false,
        finalParent,
        leaf: leafParts.reverse().join("\\"),
      };
    }
    leafParts.push(win32.basename(parent));
    const next = win32.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return { ok: false, code: "missing" in opened ? "outside" : "unopenable" };
}

export function describeExistingPath(
  candidate: string,
):
  | { ok: true; finalPath: string; directory: boolean }
  | { ok: false; code: ContainmentCode | "missing" } {
  const special = rejectSpecialPath(candidate);
  if (special) return { ok: false, code: special };
  const opened = openPath(candidate);
  if ("missing" in opened) return { ok: false, code: "missing" };
  if (!("handle" in opened)) return { ok: false, code: "unopenable" };
  const finalPath = opened.finalPath;
  closeOpened(opened);
  const attributes = GetFileAttributesW(finalPath) as number;
  if (attributes === INVALID_FILE_ATTRIBUTES) {
    return { ok: false, code: "unopenable" };
  }
  return {
    ok: true,
    finalPath,
    directory: (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0,
  };
}

export function naivePrefixContains(
  rootDir: string,
  candidate: string,
): boolean {
  const root = win32
    .resolve(rootDir)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
  const target = win32
    .resolve(candidate)
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
  return target === root || target.startsWith(`${root}\\`);
}
