import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { publishAloBundle, verifyAloBundle } from "./alo-bundle.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const owner = resolve(root, "..", "alo");
if (
  process.platform !== "win32" ||
  Number(process.versions.node.split(".")[0]) < 24 ||
  process.versions.electron
)
  throw new Error(
    "Prepare the Windows Alo bundle using standalone Node.js 24 or newer.",
  );
const npm = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
if (!existsSync(npm))
  throw new Error(
    "Alo preparation requires npm from a full standalone Node.js 24 installation.",
  );
function run(args, cwd) {
  const child = spawnSync(process.execPath, [npm, ...args], {
    cwd,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (child.error || child.status !== 0)
    throw child.error ?? new Error(`Alo preparation failed (${child.status}).`);
}
const packageInfo = JSON.parse(
  readFileSync(join(owner, "package.json"), "utf8"),
);
if (packageInfo.name !== "alo")
  throw new Error("The selected sibling is not the Alo package.");
run(["run", "build"], owner);
const scratch = join(root, ".tmp/scratch/2026-10-20-alo-package");
mkdirSync(scratch, { recursive: true });
run(
  ["pack", "--ignore-scripts", "--pack-destination", scratch, "--silent"],
  owner,
);
const bundle = resolve(root, "resources", "alo");
if (dirname(bundle) !== resolve(root, "resources"))
  throw new Error("Unexpected bundle destination.");
const staging = mkdtempSync(join(scratch, "runtime-"));
const prepared = join(staging, "prepared");
mkdirSync(prepared);
cpSync(process.execPath, join(prepared, "node.exe"));
run(
  [
    "install",
    "--prefix",
    join(prepared, "app"),
    "--omit=dev",
    "--ignore-scripts",
    "--offline",
    "--cache",
    join(owner, ".npm-cache"),
    join(scratch, `alo-${packageInfo.version}.tgz`),
  ],
  root,
);
const entry = join(prepared, "app/node_modules/alo/dist/cli/main.js");
if (!existsSync(entry)) throw new Error("The packaged Alo entry is missing.");
writeFileSync(
  join(prepared, "runtime.json"),
  JSON.stringify(
    {
      bridgeVersion: 1,
      nodeVersion: process.versions.node,
      aloVersion: packageInfo.version,
    },
    null,
    2,
  ) + "\n",
);
const smoke = spawnSync(
  join(prepared, "node.exe"),
  [entry, "environment.platform", "--json"],
  { cwd: scratch, encoding: "utf8", windowsHide: true, shell: false },
);
if (smoke.status !== 0 || JSON.parse(smoke.stdout).status !== "success")
  throw new Error("The standalone bundled Alo smoke test failed.");
verifyAloBundle({ bundle: prepared, owner });
const backup = join(staging, "previous");
if (!prepared.startsWith(root + "\\") || !backup.startsWith(root + "\\"))
  throw new Error("Unexpected runtime staging destination.");
publishAloBundle({ prepared, bundle, backup });
verifyAloBundle({ bundle, owner });
console.log(
  `Prepared standalone Node ${process.versions.node} + Alo ${packageInfo.version}.`,
);
