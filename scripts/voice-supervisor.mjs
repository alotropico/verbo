import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VOICE_IDENTITY = "verbo-voice";
export const VOICE_API_VERSION = "1";
export const DEFAULT_VOICE_BASE_URL = "http://127.0.0.1:8765";

const SERVICE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "voice-service",
);

export function voiceTokenPath(env = process.env, home = homedir()) {
  const root = env.LOCALAPPDATA || join(home, "AppData", "Local");
  return join(root, "Verbo", "voice-token");
}

export function defaultPythonPath(serviceRoot = SERVICE_ROOT) {
  const binary =
    process.platform === "win32"
      ? join("Scripts", "python.exe")
      : join("bin", "python");
  return join(serviceRoot, ".venv", binary);
}

export function parseVoiceBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Voice URL is invalid.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new Error("Voice URL must be http://127.0.0.1:<port>.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Voice URL must be an origin only.");
  }
  return url.origin;
}

export function readOrCreateToken(tokenPath) {
  try {
    return usableToken(readFileSync(tokenPath, "utf8"));
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      if (
        error instanceof Error &&
        error.message === "Voice token file is unusable."
      )
        throw error;
      if (error && error.code) throw error;
    }
  }
  mkdirSync(dirname(tokenPath), { recursive: true });
  const token = randomBytes(32).toString("hex");
  try {
    writeFileSync(tokenPath, token, { flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if (error && error.code === "EEXIST")
      return usableToken(readFileSync(tokenPath, "utf8"));
    throw error;
  }
}

function usableToken(raw) {
  const token = String(raw).trim();
  if (token.length < 16 || /[\r\n]/.test(token)) {
    throw new Error("Voice token file is unusable.");
  }
  return token;
}

function isDown(error) {
  const code = error?.cause?.code ?? error?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    error?.name === "TimeoutError" ||
    error instanceof TypeError
  );
}

async function probe(fetchImpl, baseUrl, token) {
  try {
    const response = await fetchImpl(`${baseUrl}/v1/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (response.status === 401 || response.status === 403)
      return { kind: "unauthorized" };
    if (!response.ok) return { kind: "incompatible" };
    const body = await response.json();
    if (
      body?.identity === VOICE_IDENTITY &&
      body?.apiVersion === VOICE_API_VERSION
    ) {
      return { kind: "compatible", body };
    }
    return { kind: "incompatible" };
  } catch (error) {
    if (isDown(error)) return { kind: "down" };
    return { kind: "incompatible" };
  }
}

export function parseWindowsNetstat(stdout, port) {
  const suffix = `:${port}`;
  let fallback = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== "TCP" || parts[3] !== "LISTENING")
      continue;
    const local = parts[1];
    if (!local?.endsWith(suffix)) continue;
    const host = local.slice(0, -suffix.length);
    const pid = Number(parts[4]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (host === "127.0.0.1") return pid;
    if (host === "0.0.0.0" || host === "[::1]" || host === "[::]")
      fallback = pid;
  }
  return fallback;
}

export function listeningPid(port, execFileImpl = execFile) {
  return new Promise((resolve) => {
    const done = (pid) =>
      resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
    if (process.platform === "win32") {
      execFileImpl(
        "netstat",
        ["-ano", "-p", "TCP"],
        { windowsHide: true },
        (error, stdout) => {
          done(error ? null : parseWindowsNetstat(stdout, port));
        },
      );
      return;
    }
    execFileImpl(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { windowsHide: true },
      (error, stdout) => {
        if (error) return done(null);
        done(Number(String(stdout).trim().split(/\s+/)[0]));
      },
    );
  });
}

export function createVoiceSupervisor(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const spawnImpl = options.spawnImpl ?? spawn;
  const pidLookup = options.pidLookup ?? listeningPid;
  const killPid = options.killPid ?? defaultKillPid;
  const baseUrl = parseVoiceBaseUrl(
    options.baseUrl ??
      process.env.VERBO_VOICE_BASE_URL ??
      DEFAULT_VOICE_BASE_URL,
  );
  const port = new URL(baseUrl).port;
  const tokenFile = options.tokenPath ?? voiceTokenPath();
  const serviceRoot = options.serviceRoot ?? SERVICE_ROOT;
  const pythonPath = options.pythonPath ?? defaultPythonPath(serviceRoot);
  const pythonReady = options.pythonReady ?? existsSync(pythonPath);
  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 250;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line) => console.log(line));
  const stdio = options.stdio ?? "pipe";
  let owned = null;
  let adoptedPid = null;

  async function ensure() {
    let token;
    try {
      token = readOrCreateToken(tokenFile);
    } catch (error) {
      return {
        mode: "unavailable",
        detail:
          error instanceof Error ? error.message : "Voice token is unusable.",
        child: null,
      };
    }
    const first = await probe(fetchImpl, baseUrl, token);
    if (first.kind === "compatible") {
      return adoptRunning();
    }
    if (first.kind !== "down") {
      return {
        mode: "unavailable",
        detail:
          "A process is already bound to the voice port but it is not this Verbo voice service. Typed chat still works. It was left running.",
        child: null,
      };
    }
    if (!pythonReady) {
      return {
        mode: "unavailable",
        detail:
          "Voice service Python is not installed. Typed chat still works. See voice-service/README.md.",
        child: null,
      };
    }
    let child;
    try {
      child = spawnImpl(pythonPath, ["-m", "voice_service"], {
        cwd: serviceRoot,
        env: {
          ...process.env,
          VERBO_VOICE_TOKEN: token,
          VERBO_VOICE_HOST: "127.0.0.1",
          VERBO_VOICE_PORT: port,
          VERBO_VOICE_ENGINES: "real",
        },
        windowsHide: true,
        stdio,
      });
    } catch (error) {
      return {
        mode: "unavailable",
        detail:
          error instanceof Error
            ? error.message
            : "Voice service failed to start.",
        child: null,
      };
    }
    owned = child;
    let exited = false;
    child.on?.("exit", () => {
      exited = true;
    });
    child.on?.("error", () => {
      exited = true;
    });
    if (child.stdout) {
      child.stdout.on("data", (chunk) => forward(log, chunk, token));
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => forward(log, chunk, token));
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < readyTimeoutMs) {
      if (exited) break;
      const next = await probe(fetchImpl, baseUrl, token);
      if (next.kind === "compatible") {
        return { mode: "started", detail: "Voice service started.", child };
      }
      if (next.kind !== "down") {
        stopOwned();
        return {
          mode: "unavailable",
          detail:
            "Voice port answered with an incompatible service. The owned child was stopped. Typed chat still works.",
          child: null,
        };
      }
      await sleep(pollMs);
    }
    stopOwned();
    return {
      mode: "unavailable",
      detail: "Voice service did not become ready. Typed chat still works.",
      child: null,
    };
  }

  async function adoptRunning() {
    let pid = null;
    try {
      pid = await pidLookup(Number(port));
    } catch {
      pid = null;
    }
    if (!pid || pid === process.pid) {
      return {
        mode: "reused",
        detail:
          "Voice service is already running. This app could not take ownership, so it will be left running.",
        child: null,
      };
    }
    adoptedPid = pid;
    return {
      mode: "adopted",
      detail:
        "Voice service is already running. It will stop when this app exits.",
      child: null,
    };
  }

  function stopSpawned() {
    if (owned && !owned.killed && owned.exitCode == null) {
      owned.kill();
      owned.killed = true;
    }
    owned = null;
  }

  function stopOwned() {
    stopSpawned();
  }

  async function stopVerified() {
    if (owned && !owned.killed && owned.exitCode == null) {
      stopSpawned();
      return { ok: true, summary: "Stopped the voice service Verbo started." };
    }
    if (adoptedPid == null || adoptedPid === process.pid) {
      return {
        ok: false,
        summary:
          "Voice is running outside this app and its process could not be verified. It was left running.",
      };
    }
    const current = await pidLookup(Number(port));
    if (current !== adoptedPid) {
      adoptedPid = null;
      return {
        ok: false,
        summary:
          "The voice process changed since Verbo connected. It was left running.",
      };
    }
    const pid = adoptedPid;
    adoptedPid = null;
    try {
      killPid(pid);
    } catch (error) {
      return {
        ok: false,
        summary:
          error instanceof Error
            ? error.message
            : "Voice service could not be stopped.",
      };
    }
    return { ok: true, summary: "Stopped the verified voice service." };
  }

  return { ensure, stopOwned, stopVerified, baseUrl };
}

function defaultKillPid(pid) {
  try {
    process.kill(pid);
  } catch {
    // The listener already exited.
  }
}

function forward(log, chunk, token) {
  const line = String(chunk).replaceAll(token, "[token]").slice(0, 180).trim();
  if (line) log(`[voice] ${line}`);
}

export function createLauncherShutdown({
  stopVoice,
  stopOllama,
  exit = process.exit,
  log = console.error,
}) {
  let closed = false;
  return (code) => {
    if (closed) return;
    closed = true;
    try {
      stopVoice();
    } catch (error) {
      log(error);
    }
    try {
      stopOllama();
    } catch (error) {
      log(error);
    }
    exit(code ?? 0);
  };
}
