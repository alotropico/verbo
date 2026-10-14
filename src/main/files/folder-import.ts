import { lstatSync, readdirSync } from "node:fs";
import { win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FolderKind } from "../../shared/files";
import { scopePatchSchema } from "../../shared/files";
import {
  createScopeStore,
  type ScopeFailure,
  type ScopeSuccess,
} from "../db/scopes";
import {
  readEntitySettings,
  saveProjectPreferences,
} from "../db/application-registration";
import { createRootStore } from "../db/registered-roots";
import { aliasFromFolderName, isProtectedLocation } from "./path-policy";
import { describeExistingPath, windowsFileFlags } from "./windows-containment";

const EXCLUDED = new Set([
  ".git",
  ".obsidian",
  "node_modules",
  ".cache",
  "__pycache__",
]);
const MAX_ENTRIES = 4000;

export type FolderAnalysis = {
  kind: FolderKind;
  projects: string[];
  complete: boolean;
  warnings: string[];
};

function regularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      !windowsFileFlags(path)?.reparse
    );
  } catch {
    return false;
  }
}

export function analyzeFolder(candidate: string): FolderAnalysis {
  const result: FolderAnalysis = {
    kind: "none",
    projects: [],
    complete: true,
    warnings: [],
  };
  const described = describeExistingPath(candidate);
  if (
    !described.ok ||
    !described.directory ||
    isProtectedLocation(described.finalPath)
  ) {
    return {
      ...result,
      complete: false,
      warnings: ["That folder could not be inspected."],
    };
  }
  const root = described.finalPath;
  let vault = false;
  try {
    const path = win32.join(root, ".obsidian");
    const stat = lstatSync(path);
    vault =
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      !windowsFileFlags(path)?.reparse;
  } catch {
    /* Most folders are not vaults. */
  }
  const directories = [{ path: root, level: 0 }];
  let examined = 0;
  const started = Date.now();
  while (directories.length) {
    const directory = directories.shift()!;
    if (Date.now() - started >= 1500 || examined >= MAX_ENTRIES) {
      result.complete = false;
      result.warnings.push("Project detection reached its scan limit.");
      break;
    }
    if (
      regularFile(win32.join(directory.path, "package.json")) ||
      regularFile(win32.join(directory.path, "AGENTS.md"))
    )
      result.projects.push(directory.path.replace(/^\\\\\?\\/u, ""));
    if (directory.level === 2) continue;
    try {
      for (const entry of readdirSync(directory.path, {
        withFileTypes: true,
      }).sort((left, right) => left.name.localeCompare(right.name))) {
        if (++examined > MAX_ENTRIES) {
          result.complete = false;
          result.warnings.push("Project detection reached its scan limit.");
          break;
        }
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          EXCLUDED.has(entry.name.toLowerCase())
        )
          continue;
        const path = win32.join(directory.path, entry.name);
        if (windowsFileFlags(path)?.reparse || isProtectedLocation(path))
          continue;
        directories.push({ path, level: directory.level + 1 });
      }
    } catch {
      result.complete = false;
      result.warnings.push("Some folders could not be inspected.");
    }
  }
  result.kind = vault
    ? "obsidian"
    : result.projects.length
      ? "projects"
      : "none";
  result.warnings = [...new Set(result.warnings)];
  return result;
}

export function applyImportedProjectPreferences(
  database: DatabaseSync,
  id: string,
): void {
  const settings = readEntitySettings(database);
  const project = settings.projects.find((entry) => entry.id === id);
  if (!project || !settings.projectImport?.enabled) return;
  const ids = settings.projectImport.applicationIds.filter((applicationId) =>
    settings.applications.some(
      (app) =>
        app.id === applicationId &&
        app.enabled &&
        app.supportedTargets.includes("folder"),
    ),
  );
  const saved = saveProjectPreferences(database, {
    id,
    name: project.name,
    aliases: project.aliases,
    enabled: project.enabled,
    defaultApplicationId: project.defaultApplicationId,
    favoriteApplicationIds: ids,
  });
  if (!saved.ok) throw new Error(saved.summary);
}

export function importFolderProjects(
  database: DatabaseSync,
  candidate: string,
): {
  imported: number;
  existing: number;
  complete: boolean;
  warnings: string[];
} {
  const analysis = analyzeFolder(candidate);
  const store = createRootStore(database, "registered_projects", "project");
  const current = readEntitySettings(database).projects;
  const paths = new Set(
    current.map((root) => root.path.replace(/[\\/]+$/u, "").toLowerCase()),
  );
  const aliases = new Set(
    current.flatMap((root) => [root.alias, ...root.aliases]),
  );
  let imported = 0;
  let existing = 0;
  for (const path of analysis.projects) {
    if (paths.has(path.toLowerCase())) {
      existing++;
      continue;
    }
    const base = aliasFromFolderName(path);
    let alias = base;
    let suffix = 2;
    while (aliases.has(alias)) alias = `${base.slice(0, 25)}-${suffix++}`;
    const result = store.add(alias, path);
    if (!result.ok) {
      analysis.complete = false;
      analysis.warnings.push(result.summary);
      continue;
    }
    applyImportedProjectPreferences(database, result.root.id);
    paths.add(result.root.path.toLowerCase());
    aliases.add(alias);
    imported++;
  }
  return {
    imported,
    existing,
    complete: analysis.complete,
    warnings: [...new Set(analysis.warnings)],
  };
}

export function updateFolderSettings(
  database: DatabaseSync,
  input: unknown,
): ScopeFailure | ScopeSuccess {
  const parsed = scopePatchSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      code: "invalid_settings",
      summary: parsed.error.issues[0]?.message ?? "Invalid folder settings.",
    };
  const store = createScopeStore(database);
  const scopes = store.list();
  const scope = scopes.find((entry) => entry.id === parsed.data.id);
  if (!scope)
    return {
      ok: false,
      code: "missing",
      summary: "That folder is no longer registered.",
    };
  const value = {
    alias: scope.aliases.join(", "),
    read: scope.read,
    write: scope.write,
    defaultSave: scope.defaultSave,
    kind: scope.kind ?? "none",
    ...parsed.data,
  };
  if (value.write) value.read = true;
  if (!value.write) value.defaultSave = false;
  const updates = [
    value,
    ...scopes
      .filter(
        (entry) =>
          entry.id !== scope.id && value.defaultSave && entry.defaultSave,
      )
      .map((entry) => ({
        id: entry.id,
        alias: entry.aliases.join(", "),
        read: entry.read,
        write: entry.write,
        kind: entry.kind,
        defaultSave: false,
      })),
  ];
  const result = store.apply({ removeIds: [], additions: [], updates });
  if (!result.ok || value.kind !== "projects" || scope.kind === "projects")
    return result;
  const discovery = importFolderProjects(database, scope.path);
  return {
    ...result,
    summary: `${result.summary} Imported ${discovery.imported} projects.${discovery.warnings.length ? ` ${discovery.warnings.join(" ")}` : ""}`,
  };
}
