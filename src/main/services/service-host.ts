import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { OLLAMA_BASE_URL } from "../../shared/config";
import { createServiceManager, type ServiceManager } from "./service-manager";

type VoiceModule = {
  createVoiceSupervisor: (options?: {
    serviceRoot?: string;
    log?: (line: string) => void;
  }) => {
    ensure: () => Promise<{
      mode: string;
      detail: string;
      child: { pid?: number } | null;
    }>;
    stopOwned: () => void;
    stopVerified: () => Promise<{ ok: boolean; summary: string }>;
  };
};

let singleton: ServiceManager | null = null;
let voiceStopOwned = (): void => undefined;
let voiceStopVerified = async (): Promise<{
  ok: boolean;
  summary: string;
}> => ({
  ok: false,
  summary: "Voice is not running.",
});

function repoRoot(appPath: string): string {
  if (existsSync(join(appPath, "scripts", "voice-supervisor.mjs")))
    return appPath;
  const parent = join(appPath, "..", "..");
  if (existsSync(join(parent, "scripts", "voice-supervisor.mjs")))
    return parent;
  return appPath;
}

function ollamaExecutable(): string | null {
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

async function probeOllama(): Promise<{ ok: boolean; version: string | null }> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/version`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return { ok: false, version: null };
    const body = (await response.json()) as { version?: string };
    return { ok: true, version: body.version ?? null };
  } catch {
    return { ok: false, version: null };
  }
}

function spawnOllama(): { pid: number | null; kill: () => void } {
  const executable = ollamaExecutable();
  if (!executable) {
    throw new Error(
      "Ollama is not running and `ollama` was not found on PATH.",
    );
  }
  const child: ChildProcess = spawn(executable, ["serve"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return {
    pid: child.pid ?? null,
    kill: () => {
      if (!child.killed) child.kill();
    },
  };
}

async function waitOllama(): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if ((await probeOllama()).ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

export async function serviceManager(appPath: string): Promise<ServiceManager> {
  if (singleton) return singleton;
  const root = repoRoot(appPath);
  let ensureVoice = async (): Promise<{
    mode: string;
    detail: string;
    pid: number | null;
    owned: boolean;
  }> => ({
    mode: "unavailable",
    detail: "Voice service could not be loaded. Typed chat still works.",
    pid: null,
    owned: false,
  });
  try {
    const loaded = (await import(
      /* @vite-ignore */ pathToFileURL(
        join(root, "scripts", "voice-supervisor.mjs"),
      ).href
    )) as VoiceModule;
    const voice = loaded.createVoiceSupervisor({
      serviceRoot: join(root, "voice-service"),
      log: (line) => console.log(line),
    });
    voiceStopOwned = () => voice.stopOwned();
    voiceStopVerified = () => voice.stopVerified();
    ensureVoice = async () => {
      const state = await voice.ensure();
      return {
        mode: state.mode,
        detail: state.detail,
        pid: state.child?.pid ?? null,
        owned: state.mode === "started",
      };
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Voice service could not be loaded.";
    ensureVoice = async () => ({
      mode: "unavailable",
      detail: `${message} Typed chat still works.`,
      pid: null,
      owned: false,
    });
  }
  singleton = createServiceManager({
    probeOllama,
    spawnOllama,
    waitOllama,
    ensureVoice: () => ensureVoice(),
    stopVoiceSpawned: () => voiceStopOwned(),
    stopVoiceVerified: () => voiceStopVerified(),
  });
  return singleton;
}
