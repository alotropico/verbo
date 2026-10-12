import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPythonPath } from "./voice-supervisor.mjs";

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "voice-service",
);
const python = defaultPythonPath(root);

if (!existsSync(python)) {
  console.error(
    "Voice tests need voice-service/.venv. See voice-service/README.md.",
  );
  process.exit(1);
}

const child = spawn(python, ["-m", "pytest"], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
