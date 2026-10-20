import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

function distDigest(root) {
  const digest = createHash("sha256");
  function walk(directory, relative = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, name);
      else if (entry.isFile())
        digest.update(name).update("\0").update(readFileSync(path));
      else throw new Error("Unexpected entry in the Alo build.");
    }
  }
  walk(root);
  return digest.digest("hex");
}

export function verifyAloBundle({ bundle, owner }) {
  const installed = join(bundle, "app/node_modules/alo/dist");
  if (
    !existsSync(join(bundle, "node.exe")) ||
    !existsSync(join(installed, "cli/main.js"))
  )
    throw new Error(
      "The Alo bundle is incomplete. Run npm run alo:prepare before packaging.",
    );
  if (distDigest(join(owner, "dist")) !== distDigest(installed))
    throw new Error(
      "The Alo bundle is stale. Run npm run alo:prepare before packaging.",
    );
}

// Windows may briefly retain the smoke-tested executable or its native library.
function renameRuntime(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        attempt >= 24 ||
        !["EPERM", "EBUSY", "EACCES"].includes(error.code)
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

/** Publish only a fully prepared runtime; a failed swap restores the prior bundle. */
export function publishAloBundle({
  prepared,
  bundle,
  backup,
  rename = renameRuntime,
}) {
  const previous = existsSync(bundle);
  if (previous) rename(bundle, backup);
  try {
    rename(prepared, bundle);
  } catch (error) {
    if (previous) rename(backup, bundle);
    throw error;
  }
}
