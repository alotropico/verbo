import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WEB_IDENTITY = "verbo-web";
export const WEB_API_VERSION = "1";
export const DEFAULT_WEB_BASE_URL = "http://127.0.0.1:8766";

const SERVICE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "web-service");

export function webTokenPath(env = process.env, home = homedir()) {
  const root = env.LOCALAPPDATA || join(home, "AppData", "Local");
  return join(root, "Verbo", "web-token");
}

export function defaultPythonPath(serviceRoot = SERVICE_ROOT) {
  const binary = process.platform === "win32" ? join("Scripts", "python.exe") : join("bin", "python");
  return join(serviceRoot, ".venv", binary);
}

export function parseWebBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Web URL is invalid.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new Error("Web URL must be http://127.0.0.1:<port>.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Web URL must be an origin only.");
  }
  return url.origin;
}

export function readOrCreateToken(tokenPath) {
  try {
    return usableToken(readFileSync(tokenPath, "utf8"));
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      if (error instanceof Error && error.message === "Web token file is unusable.") throw error;
      if (error && error.code) throw error;
    }
  }
  mkdirSync(dirname(tokenPath), { recursive: true });
  const token = randomBytes(32).toString("hex");
  try {
    writeFileSync(tokenPath, token, { flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if (error && error.code === "EEXIST") return usableToken(readFileSync(tokenPath, "utf8"));
    throw error;
  }
}

function usableToken(raw) {
  const token = String(raw).trim();
  if (token.length < 16 || /[\r\n]/.test(token)) {
    throw new Error("Web token file is unusable.");
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

function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener("abort", cancel);
      resolve(null);
    };
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}

async function probe(fetchImpl, baseUrl, token, signal) {
  try {
    const deadline = AbortSignal.timeout(1500);
    const response = await untilAborted(
      fetchImpl(`${baseUrl}/v1/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      }),
      signal,
    );
    if (signal?.aborted) return { kind: "cancelled" };
    if (response.status === 401 || response.status === 403) return { kind: "unauthorized" };
    if (!response.ok) return { kind: "incompatible" };
    const body = await untilAborted(response.json(), signal);
    if (signal?.aborted) return { kind: "cancelled" };
    if (body?.identity === WEB_IDENTITY && body?.apiVersion === WEB_API_VERSION) {
      if (body?.ready === true) {
        return { kind: "compatible", body };
      }
      return { kind: "unready", body };
    }
    return { kind: "incompatible" };
  } catch (error) {
    if (signal?.aborted) return { kind: "cancelled" };
    if (isDown(error)) return { kind: "down" };
    return { kind: "incompatible" };
  }
}

export function parseWindowsNetstat(stdout, port) {
  const suffix = `:${port}`;
  let fallback = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== "TCP" || parts[3] !== "LISTENING") continue;
    const local = parts[1];
    if (!local?.endsWith(suffix)) continue;
    const host = local.slice(0, -suffix.length);
    const pid = Number(parts[4]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (host === "127.0.0.1") return pid;
    if (host === "0.0.0.0" || host === "[::1]" || host === "[::]") fallback = pid;
  }
  return fallback;
}

export function listeningPid(port, execFileImpl = execFile) {
  return new Promise((resolve) => {
    const done = (pid) => resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
    if (process.platform === "win32") {
      execFileImpl("netstat", ["-ano", "-p", "TCP"], { windowsHide: true }, (error, stdout) => {
        done(error ? null : parseWindowsNetstat(stdout, port));
      });
      return;
    }
    execFileImpl("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { windowsHide: true }, (error, stdout) => {
      if (error) return done(null);
      done(Number(String(stdout).trim().split(/\s+/)[0]));
    });
  });
}

export function createWebSupervisor(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const spawnImpl = options.spawnImpl ?? spawn;
  const pidLookup = options.pidLookup ?? listeningPid;
  const killPid = options.killPid ?? defaultKillPid;
  const baseUrl = parseWebBaseUrl(options.baseUrl ?? process.env.VERBO_WEB_BASE_URL ?? DEFAULT_WEB_BASE_URL);
  const port = new URL(baseUrl).port;
  const tokenFile = options.tokenPath ?? webTokenPath();
  const serviceRoot = options.serviceRoot ?? SERVICE_ROOT;
  const pythonPath = options.pythonPath ?? defaultPythonPath(serviceRoot);
  const pythonReady = options.pythonReady ?? existsSync(pythonPath);
  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 250;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line) => console.log(line));
  const stdio = options.stdio ?? "pipe";

  let owned = null;
  let adoptedPid = null;
  let unverifiedReuse = false;
  let pendingEnsure = null;
  let startupController = null;

  const cancelled = () => ({
    mode: "unavailable",
    detail: "Web search startup was cancelled.",
    child: null,
    pid: null,
  });

  async function ensure() {
    if (startupController?.signal.aborted && pendingEnsure) await pendingEnsure;
    if (pendingEnsure) {
      return pendingEnsure;
    }
    startupController = new AbortController();
    pendingEnsure = doEnsure(startupController.signal).finally(() => {
      pendingEnsure = null;
      startupController = null;
    });
    return pendingEnsure;
  }

  async function doEnsure(signal) {
    let token;
    try {
      token = readOrCreateToken(tokenFile);
    } catch (error) {
      return {
        mode: "unavailable",
        detail: error instanceof Error ? error.message : "Web token is unusable.",
        child: null,
        pid: null,
      };
    }

    // Preserve already-owned live child
    if (owned && !owned.killed && owned.exitCode == null) {
      const currentChild = owned;
      const probeRes = await probe(fetchImpl, baseUrl, token, signal);
      if (signal.aborted) return cancelled();
      if (owned === currentChild && !currentChild.killed && currentChild.exitCode == null) {
        return {
          mode: probeRes.kind === "compatible" ? "started" : "unavailable",
          detail:
            probeRes.kind === "compatible"
              ? "Web search service started."
              : "The web search process Verbo started is still running but is not ready. No additional process was started.",
          child: currentChild,
          pid: currentChild.pid ?? null,
        };
      }
    }

    const first = await probe(fetchImpl, baseUrl, token, signal);
    if (signal.aborted) return cancelled();
    if (first.kind === "compatible") {
      return adoptRunning(signal);
    }
    if (first.kind === "unready") {
      return {
        mode: "unavailable",
        detail: first.body?.detail || "Web search service is initializing or not ready.",
        child: null,
        pid: null,
      };
    }
    if (first.kind !== "down") {
      return {
        mode: "unavailable",
        detail:
          "A process is already bound to the web search port but it is not this Verbo web service. Typed chat still works. It was left running.",
        child: null,
        pid: null,
      };
    }
    if (!pythonReady) {
      return {
        mode: "unavailable",
        detail: "Web search service Python is not installed. Typed chat still works. See web-service/README.md.",
        child: null,
        pid: null,
      };
    }

    let child;
    if (signal.aborted) return cancelled();
    try {
      child = spawnImpl(pythonPath, ["-m", "web_service"], {
        cwd: serviceRoot,
        env: {
          ...process.env,
          VERBO_WEB_TOKEN: token,
          VERBO_WEB_HOST: "127.0.0.1",
          VERBO_WEB_PORT: port,
        },
        windowsHide: true,
        stdio,
      });
    } catch (error) {
      return {
        mode: "unavailable",
        detail: error instanceof Error ? error.message : "Web search service failed to start.",
        child: null,
        pid: null,
      };
    }

    adoptedPid = null;
    unverifiedReuse = false;
    owned = child;
    let exited = false;
    child.on?.("exit", () => {
      exited = true;
      if (owned === child) {
        owned = null;
      }
    });
    child.on?.("error", () => {
      exited = true;
      if (owned === child) {
        owned = null;
      }
    });

    if (child.stdout) {
      child.stdout.on("data", (chunk) => forward(log, chunk, token));
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => forward(log, chunk, token));
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < readyTimeoutMs) {
      if (signal.aborted) return cancelled();
      if (exited) break;
      const next = await probe(fetchImpl, baseUrl, token, signal);
      if (signal.aborted) return cancelled();
      if (next.kind === "compatible") {
        return {
          mode: "started",
          detail: "Web search service started.",
          child,
          pid: child.pid ?? null,
        };
      }
      if (next.kind !== "down" && next.kind !== "unready") {
        stopOwned();
        return {
          mode: "unavailable",
          detail: "Web search port answered with an incompatible service. The owned child was stopped. Typed chat still works.",
          child: null,
          pid: null,
        };
      }
      await untilAborted(sleep(pollMs), signal);
    }

    stopOwned();
    return {
      mode: "unavailable",
      detail: "Web search service did not become ready. Typed chat still works.",
      child: null,
      pid: null,
    };
  }

  async function adoptRunning(signal) {
    let pid = null;
    try {
      pid = await untilAborted(pidLookup(Number(port)), signal);
    } catch {
      pid = null;
    }
    if (signal.aborted) return cancelled();
    if (!pid || pid === process.pid) {
      unverifiedReuse = true;
      return {
        mode: "reused",
        detail: "Web search service is already running. This app could not take ownership, so it will be left running.",
        child: null,
        pid: null,
      };
    }
    unverifiedReuse = false;
    adoptedPid = pid;
    return {
      mode: "adopted",
      detail: "Web search service is already running. It will stop when this app exits.",
      child: null,
      pid,
    };
  }

  function stopSpawned() {
    if (owned && !owned.killed && owned.exitCode == null) {
      const child = owned;
      try {
        if (child.kill() === false) {
          return { ok: false, summary: "The web search process could not be stopped." };
        }
        if (owned === child) owned = null;
      } catch (error) {
        return { ok: false, summary: error instanceof Error ? error.message : "The web search process could not be stopped." };
      }
    } else {
      owned = null;
    }
    return { ok: true, summary: "Stopped the web search service Verbo started." };
  }

  function stopOwned() {
    startupController?.abort();
    return stopSpawned();
  }

  async function stopVerified() {
    startupController?.abort();
    const pending = pendingEnsure;
    if (owned && !owned.killed && owned.exitCode == null) {
      const stopped = stopSpawned();
      await pending;
      return stopped;
    }
    await pending;
    if (adoptedPid == null || adoptedPid === process.pid) {
      if (pending) return { ok: true, summary: "Web search startup was cancelled." };
      return {
        ok: !unverifiedReuse,
        summary: unverifiedReuse
          ? "Web search is running outside this app and its process could not be verified. It was left running."
          : "No managed web search process is running.",
      };
    }

    let token;
    try {
      token = usableToken(readFileSync(tokenFile, "utf8"));
    } catch {
      return {
        ok: false,
        summary: "The web search token is unavailable. Its process could not be authenticated and was left running.",
      };
    }

    // Reverification: listener PID ownership
    const current = await pidLookup(Number(port));
    if (current !== adoptedPid) {
      adoptedPid = null;
      return {
        ok: false,
        summary: "The web search process changed since Verbo connected. It was left running.",
      };
    }

    // Reverification: authenticated identity check
    const check = await probe(fetchImpl, baseUrl, token);
    if (check.kind !== "compatible" || (await pidLookup(Number(port))) !== adoptedPid) {
      adoptedPid = null;
      return {
        ok: false,
        summary: "The web search process identity could not be verified before stopping. It was left running.",
      };
    }

    const pid = adoptedPid;
    adoptedPid = null;
    try {
      killPid(pid);
    } catch (error) {
      return {
        ok: false,
        summary: error instanceof Error ? error.message : "Web search service could not be stopped.",
      };
    }
    return { ok: true, summary: "Stopped the verified web search service." };
  }

  return { ensure, stopOwned, stopVerified, baseUrl };
}

function defaultKillPid(pid) {
  try {
    process.kill(pid);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function forward(log, chunk, token) {
  const line = String(chunk).replaceAll(token, "[token]").slice(0, 180).trim();
  if (line) log(`[web] ${line}`);
}
