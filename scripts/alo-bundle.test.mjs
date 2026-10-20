import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { publishAloBundle, verifyAloBundle } from "./alo-bundle.mjs";
import { renameSync } from "node:fs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "verbo-alo-bundle-"));
  directories.push(root);
  const bundle = join(root, "bundle"),
    owner = join(root, "owner");
  for (const dist of [
    join(bundle, "app/node_modules/alo/dist"),
    join(owner, "dist"),
  ]) {
    mkdirSync(join(dist, "cli"), { recursive: true });
    writeFileSync(join(dist, "cli/main.js"), "current commands");
  }
  writeFileSync(join(bundle, "node.exe"), "fixture runtime");
  return { root, bundle, owner };
}
it("refuses packaging a stale or incomplete command runtime", () => {
  const { bundle, owner } = fixture();
  expect(() => verifyAloBundle({ bundle, owner })).not.toThrow();
  writeFileSync(join(owner, "dist/cli/main.js"), "updated commands");
  expect(() => verifyAloBundle({ bundle, owner })).toThrow("stale");
  rmSync(join(bundle, "node.exe"));
  expect(() => verifyAloBundle({ bundle, owner })).toThrow("incomplete");
});
it("restores the previous bundle when publishing the prepared runtime fails", () => {
  const { root, bundle } = fixture();
  const prepared = join(root, "prepared"),
    backup = join(root, "backup");
  mkdirSync(prepared);
  writeFileSync(join(prepared, "node.exe"), "new runtime");
  expect(() =>
    publishAloBundle({
      prepared,
      bundle,
      backup,
      rename: (from, to) => {
        if (from === prepared) throw new Error("Runtime is locked");
        renameSync(from, to);
      },
    }),
  ).toThrow("locked");
  expect(readFileSync(join(bundle, "node.exe"), "utf8")).toBe(
    "fixture runtime",
  );
  expect(readFileSync(join(prepared, "node.exe"), "utf8")).toBe("new runtime");
});
it("publishes the prepared runtime while retaining the prior runtime as a backup", () => {
  const { root, bundle } = fixture();
  const prepared = join(root, "prepared"),
    backup = join(root, "backup");
  mkdirSync(prepared);
  writeFileSync(join(prepared, "node.exe"), "new runtime");
  publishAloBundle({ prepared, bundle, backup });
  expect(readFileSync(join(bundle, "node.exe"), "utf8")).toBe("new runtime");
  expect(readFileSync(join(backup, "node.exe"), "utf8")).toBe(
    "fixture runtime",
  );
});
