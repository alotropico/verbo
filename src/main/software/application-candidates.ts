import {
  findSoftware,
  windowsSoftwareSource,
  type SoftwareSource,
} from "./inventory";
import { executableIdentity } from "./executable-identity";
import { win32 } from "node:path";
import { readdirSync } from "node:fs";

export function discoverApplicationCandidates(
  source: SoftwareSource = windowsSoftwareSource(),
): Array<{ name: string; aliases: string[]; executable: string }> {
  if (source.platform !== "win32") return [];
  const inventory = source.installed();
  const cachedSource = { ...source, installed: () => inventory };
  const candidates = [
    {
      name: "Cursor",
      token: "Cursor",
      binary: "Cursor.exe",
      folder: "Cursor",
      aliases: ["cursor"],
    },
    {
      name: "Visual Studio Code",
      token: "Code",
      binary: "Code.exe",
      folder: "Microsoft VS Code",
      aliases: ["vsc", "vscode", "code"],
    },
    {
      name: "Sublime Merge",
      token: "Sublime Merge",
      binary: "sublime_merge.exe",
      folder: "Sublime Merge",
      aliases: ["smerge", "sublime-merge"],
    },
  ];
  const known = candidates.flatMap((candidate) => {
    const found = findSoftware({ source: cachedSource, name: candidate.token });
    if (!found.ok) return [];
    const paths = found.matches.flatMap((hit) => [
      hit.path,
      win32.join(hit.path, candidate.binary),
    ]);
    // Probe conventional installation locations; only existing, verified files are offered.
    for (const root of [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA
        ? win32.join(process.env.LOCALAPPDATA, "Programs")
        : undefined,
    ])
      if (root)
        paths.push(win32.join(root, candidate.folder, candidate.binary));
    for (const path of paths) {
      try {
        const checked = executableIdentity(path);
        return [
          {
            name: candidate.name,
            aliases: candidate.aliases,
            executable: checked.path,
          },
        ];
      } catch {
        /* Inventory entries and shell wrappers are candidates, never trust. */
      }
    }
    return [];
  });
  const results = [...known];
  const seen = new Set(results.map((item) => item.executable.toLowerCase()));
  const started = Date.now();
  for (const program of inventory.programs.slice(0, 256)) {
    if (Date.now() - started > 2000 || results.length >= 256) break;
    if (
      !program.location ||
      !win32.isAbsolute(program.location) ||
      program.location.startsWith("\\\\")
    )
      continue;
    try {
      const binaries = readdirSync(program.location, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            /\.exe$/iu.test(entry.name) &&
            !/(unins|uninstall|update|crash|helper|setup)/iu.test(entry.name),
        )
        .slice(0, 12);
      for (const entry of binaries) {
        if (results.length >= 256) break;
        try {
          const checked = executableIdentity(
            win32.join(program.location, entry.name),
          );
          if (seen.has(checked.path.toLowerCase())) continue;
          const alias = entry.name
            .replace(/\.exe$/iu, "")
            .toLowerCase()
            .replace(/[^a-z0-9-]/gu, "-")
            .replace(/^-+|-+$/gu, "")
            .slice(0, 32);
          if (!/^[a-z][a-z0-9-]{1,31}$/u.test(alias)) continue;
          seen.add(checked.path.toLowerCase());
          results.push({
            name:
              binaries.length === 1
                ? program.name.slice(0, 100)
                : `${program.name} · ${entry.name}`.slice(0, 100),
            aliases: [alias],
            executable: checked.path,
          });
        } catch {
          /* Only verified PE files are offered. */
        }
      }
    } catch {
      /* Stale inventory entries are skipped. */
    }
  }
  return results.sort((left, right) => left.name.localeCompare(right.name));
}
