import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootDev } from "./dev-boot.mjs";
import {
  createLauncherShutdown,
  createVoiceSupervisor,
} from "./voice-supervisor.mjs";

const OLLAMA_URL = "http://127.0.0.1:11434";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MODEL = "qwen3.5:4b-q4_K_M";

/** Child process only if this launcher started `ollama serve` (never kill a pre-existing server). */
let ownedOllama = null;
let startedOllamaServe = false;
const voice = createVoiceOrUnavailable();

function stopOwnedOllama() {
  if (startedOllamaServe && ownedOllama && !ownedOllama.killed) {
    ownedOllama.kill();
  }
}

const shutdown = createLauncherShutdown({
  stopVoice: () => voice.stopOwned(),
  stopOllama: stopOwnedOllama,
});

async function fetchJson(path, timeoutMs = 3000) {
  const response = await fetch(`${OLLAMA_URL}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function isOllamaUp() {
  try {
    await fetchJson("/api/version", 2500);
    return true;
  } catch {
    return false;
  }
}

function resolveOllamaExecutable() {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    const candidate = join(
      dir,
      process.platform === "win32" ? "ollama.exe" : "ollama",
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOllama(maxMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await isOllamaUp()) return true;
    await sleep(500);
  }
  return false;
}

async function verifyModel() {
  const configured = process.env.VERBO_MODEL ?? DEFAULT_MODEL;
  const tags = await fetchJson("/api/tags");
  const models = (tags.models ?? []).map((m) => m.name);
  if (!models.includes(configured)) {
    console.error(`Configured model "${configured}" is not installed.`);
    console.error(`Installed models: ${models.join(", ") || "(none)"}`);
    console.error("Install with: ollama pull " + configured);
    process.exit(1);
  }
}

async function ensureOllama() {
  // 1) Prefer an already-running server (API check, not process name).
  if (await isOllamaUp()) {
    console.log("Ollama already running — reusing existing server.");
    return;
  }

  // Brief pause: another `ollama serve` may be binding the port right now.
  await sleep(400);
  if (await isOllamaUp()) {
    console.log("Ollama became reachable — reusing existing server.");
    return;
  }

  const exe = resolveOllamaExecutable();
  if (!exe) {
    console.error("Ollama is not running and `ollama` was not found on PATH.");
    process.exit(1);
  }

  console.log("Ollama not reachable — starting `ollama serve`…");
  startedOllamaServe = true;
  ownedOllama = spawn(exe, ["serve"], {
    stdio: "inherit",
    detached: false,
    windowsHide: true,
  });

  ownedOllama.on("error", (err) => {
    console.error("Failed to start Ollama:", err.message);
    process.exit(1);
  });

  ownedOllama.on("exit", () => {
    ownedOllama = null;
    startedOllamaServe = false;
  });

  const ready = await waitForOllama();
  if (ready) {
    console.log("Ollama is ready.");
    return;
  }

  // Port-in-use race: another process may have won while we spawned.
  if (await isOllamaUp()) {
    console.log("Ollama is reachable — reusing existing server.");
    if (ownedOllama && !ownedOllama.killed) {
      ownedOllama.kill();
    }
    ownedOllama = null;
    startedOllamaServe = false;
    return;
  }

  console.error("Timed out waiting for Ollama at", OLLAMA_URL);
  process.exit(1);
}

function createVoiceOrUnavailable() {
  try {
    return createVoiceSupervisor();
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Voice URL is invalid.";
    return {
      async ensure() {
        return {
          mode: "unavailable",
          detail: `${detail} Typed chat still works.`,
          child: null,
        };
      },
      stopOwned: () => undefined,
    };
  }
}

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

  process.on("SIGINT", () => {
    child.kill("SIGINT");
  });
  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
  });

  child.on("exit", (code) => shutdown(code ?? 0));
}

async function main() {
  await bootDev({
    ensureOllama,
    verifyModel,
    ensureVoice: () => voice.ensure(),
    runDev,
    log: (message) => console.log(message),
  });
}

main().catch((err) => {
  console.error(err);
  shutdown(1);
});
