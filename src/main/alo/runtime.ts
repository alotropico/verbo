import { app } from "electron";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
/** Always Alo-only. Overrides select isolated test/development paths, never a local fallback. */
export function aloRuntime(): { node: string; entry: string; profile: string } {
  const node = process.env.VERBO_ALO_NODE,
    entry = process.env.VERBO_ALO_ENTRY,
    profile = process.env.VERBO_ALO_PROFILE;
  if (node || entry || profile) {
    if (
      !node ||
      !entry ||
      !profile ||
      ![node, entry, profile].every(isAbsolute)
    )
      throw new Error(
        "Alo overrides require three absolute runtime, entry and profile paths.",
      );
    return { node, entry, profile };
  }
  const root = join(
    app.isPackaged
      ? process.resourcesPath
      : join(app.getAppPath(), "resources"),
    "alo",
  );
  const runtime = {
    node: join(root, "node.exe"),
    entry: join(root, "app", "node_modules", "alo", "dist", "cli", "main.js"),
    profile: join(app.getPath("appData"), "alo", "alo.sqlite"),
  };
  if (!existsSync(runtime.node) || !existsSync(runtime.entry))
    throw new Error(
      "The bundled Alo runtime is missing. Run npm run alo:prepare or reinstall the matching package.",
    );
  return runtime;
}
