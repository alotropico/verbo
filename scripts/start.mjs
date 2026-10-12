import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootDev } from "./dev-boot.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function runDev() {
  const electronViteCli = join(
    ROOT,
    "node_modules",
    "electron-vite",
    "bin",
    "electron-vite.js",
  );
  const child = spawn(process.execPath, [electronViteCli, "dev"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  const forward = (signal) => {
    child.kill(signal);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

bootDev({
  runDev,
  log: (message) => console.log(message),
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
