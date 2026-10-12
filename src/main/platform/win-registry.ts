import koffi from "koffi";
import type { InstalledProgram } from "../../shared/software";

const HKCU = 0xffffffff80000001n;
const HKLM = 0xffffffff80000002n;
const KEY_READ = 0x20019;
const KEY_WOW64_64KEY = 0x100;
const KEY_WOW64_32KEY = 0x200;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_FILE_NOT_FOUND = 2;
const REG_SZ = 1;
const REG_DWORD = 4;
const MAX_KEYS = 1500;
const MAX_MS = 2500;

const hives = { HKCU, HKLM } as const;

const advapi32 = koffi.load("advapi32.dll");
const RegOpenKeyExW = advapi32.func(
  "int32 __stdcall RegOpenKeyExW(uintptr hKey, str16 lpSubKey, uint32 ulOptions, uint32 samDesired, _Out_ uintptr *phkResult)",
);
const RegCloseKey = advapi32.func("int32 __stdcall RegCloseKey(uintptr hKey)");
const RegEnumKeyExW = advapi32.func(
  "int32 __stdcall RegEnumKeyExW(uintptr hKey, uint32 dwIndex, _Out_ uint16_t *lpName, _Inout_ uint32 *lpcchName, uintptr lpReserved, uintptr lpClass, uintptr lpcchClass, uintptr lpftLastWriteTime)",
);
const RegQueryValueExW = advapi32.func(
  "int32 __stdcall RegQueryValueExW(uintptr hKey, str16 lpValueName, uintptr lpReserved, _Out_ uint32 *lpType, _Out_ uint8_t *lpData, _Inout_ uint32 *lpcbData)",
);

type Hive = keyof typeof hives;

function closeKey(handle: unknown): void {
  if (typeof handle === "number" || typeof handle === "bigint") {
    RegCloseKey(handle);
  }
}

function openHandle(
  parent: unknown,
  subkey: string,
  sam = KEY_READ,
): unknown | null {
  const opened: unknown[] = [0];
  const status = RegOpenKeyExW(parent, subkey, 0, sam, opened) as number;
  if (status !== 0) return null;
  return opened[0];
}

function openKey(hive: Hive, subkey: string, sam = KEY_READ): unknown | null {
  return openHandle(hives[hive], subkey, sam);
}

function decodeText(buffer: Buffer, bytes: number): string {
  if (bytes < 2) return "";
  return buffer
    .toString("utf16le", 0, bytes - (bytes % 2 === 0 ? 2 : 0))
    .replace(/\0.*$/u, "")
    .trim();
}

function queryValue(
  key: unknown,
  name: string,
): { type: number; text: string; dword: number } | null {
  const data = Buffer.alloc(1024);
  const size = [data.length];
  const type = [0];
  const status = RegQueryValueExW(key, name, 0, type, data, size) as number;
  if (status === ERROR_FILE_NOT_FOUND || status !== 0) return null;
  const bytes = size[0] ?? 0;
  if (type[0] === REG_DWORD && bytes >= 4) {
    return { type: REG_DWORD, text: "", dword: data.readUInt32LE(0) };
  }
  if (type[0] !== REG_SZ) return null;
  return { type: REG_SZ, text: decodeText(data, bytes), dword: 0 };
}

export function readRegistryString(
  hive: Hive,
  subkey: string,
  value: string,
): string | null {
  const key = openKey(hive, subkey);
  if (!key) return null;
  try {
    const read = queryValue(key, value);
    if (!read || read.type !== REG_SZ || !read.text) return null;
    if (read.text.includes("%")) return null;
    return read.text;
  } finally {
    closeKey(key);
  }
}

function locationOf(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 260) return "";
  if (/[%&|<>"\r\n]/u.test(trimmed)) return "";
  if (!/^[a-z]:\\[^:*?"<>|]+$/iu.test(trimmed)) return "";
  return trimmed;
}

function clip(value: string, max: number): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f]/gu, "")
      .trim()
      .slice(0, max)
  );
}

export function readInstalledPrograms(now = Date.now()): {
  programs: InstalledProgram[];
  complete: boolean;
} {
  const roots: Array<[Hive, number]> = [
    ["HKLM", KEY_READ | KEY_WOW64_64KEY],
    ["HKLM", KEY_READ | KEY_WOW64_32KEY],
    ["HKCU", KEY_READ],
  ];
  const subkey = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
  const seen = new Set<string>();
  const programs: InstalledProgram[] = [];
  let complete = true;
  const started = now;

  for (const [hive, sam] of roots) {
    const root = openKey(hive, subkey, sam);
    if (!root) continue;
    try {
      for (let index = 0; index < MAX_KEYS; index += 1) {
        if (Date.now() - started > MAX_MS || programs.length >= MAX_KEYS) {
          complete = false;
          break;
        }
        const nameBuffer = Buffer.alloc(512);
        const nameLength = [255];
        const status = RegEnumKeyExW(
          root,
          index,
          nameBuffer,
          nameLength,
          0,
          0,
          0,
          0,
        ) as number;
        if (status === ERROR_NO_MORE_ITEMS) break;
        if (status !== 0) continue;
        const childName = nameBuffer
          .toString("utf16le", 0, (nameLength[0] ?? 0) * 2)
          .replace(/\0.*$/u, "");
        if (!childName || /[\\/]/.test(childName)) continue;
        const child = openHandle(root, childName, KEY_READ);
        if (!child) continue;
        try {
          const system = queryValue(child, "SystemComponent");
          if (system?.type === REG_DWORD && system.dword === 1) continue;
          const display = queryValue(child, "DisplayName");
          const name = clip(display?.text ?? "", 160);
          if (!name) continue;
          const version = clip(
            queryValue(child, "DisplayVersion")?.text ?? "",
            40,
          );
          const publisher = clip(
            queryValue(child, "Publisher")?.text ?? "",
            120,
          );
          const location = locationOf(
            queryValue(child, "InstallLocation")?.text ?? "",
          );
          const key = `${name}\0${version}\0${location}`.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          programs.push({ name, version, publisher, location });
        } finally {
          closeKey(child);
        }
      }
    } finally {
      closeKey(root);
    }
    if (!complete) break;
  }

  programs.sort((left, right) => left.name.localeCompare(right.name));
  return { programs, complete };
}
