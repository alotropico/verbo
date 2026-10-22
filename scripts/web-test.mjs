import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPythonPath } from "./web-supervisor.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "web-service");
const python = defaultPythonPath(root);

if (!existsSync(python)) {
  console.error("Web search tests need web-service/.venv. See web-service/README.md.");
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
