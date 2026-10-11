import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { scopeAliasSchema } from "../../shared/files";
import type { ScopeAddition, ScopeStore } from "../db/scopes";
import {
  DEFAULT_SCOPE_ALIAS,
  ensureProposedDefaultDirectory,
} from "./default-scope";

const installationFileSchema = z
  .object({
    scopes: z
      .array(
        z
          .object({
            alias: scopeAliasSchema,
            path: z.string().trim().min(1).max(1024),
            read: z.boolean(),
            write: z.boolean(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

function pathKey(path: string): string {
  return path
    .replace(/^\\\\\?\\/u, "")
    .replace(/[\\/]+$/u, "")
    .toLowerCase();
}

export function readInstallationScopes(projectRoot: string): ScopeAddition[] {
  const file = join(projectRoot, "installation-scopes.local.json");
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return [];
  }
  const result = installationFileSchema.safeParse(parsed);
  if (!result.success) return [];
  return result.data.scopes.map((scope) => ({
    alias: scope.alias,
    path: scope.path,
    read: scope.read,
    write: scope.write,
    defaultSave: false,
  }));
}

export function ensureInstalledFileScopes(
  store: ScopeStore,
  projectRoot: string,
): void {
  const tmp = ensureProposedDefaultDirectory(projectRoot);
  const current = store.list();
  const aliases = new Set(current.map((scope) => scope.alias.toLowerCase()));
  const paths = new Set(current.map((scope) => pathKey(scope.path)));
  const hasDefault = current.some((scope) => scope.defaultSave);
  const additions: ScopeAddition[] = [];
  if (!aliases.has(DEFAULT_SCOPE_ALIAS) && !paths.has(pathKey(tmp))) {
    additions.push({
      alias: DEFAULT_SCOPE_ALIAS,
      path: tmp,
      read: true,
      write: true,
      defaultSave: !hasDefault,
    });
    aliases.add(DEFAULT_SCOPE_ALIAS);
    paths.add(pathKey(tmp));
  }
  for (const extra of readInstallationScopes(projectRoot)) {
    const alias = extra.alias.toLowerCase();
    const key = pathKey(extra.path);
    if (aliases.has(alias) || paths.has(key)) continue;
    additions.push(extra);
    aliases.add(alias);
    paths.add(key);
  }
  for (const addition of additions) {
    store.apply({ removeIds: [], updates: [], additions: [addition] });
  }
}
