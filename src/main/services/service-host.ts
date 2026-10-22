import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServiceManager, type ServiceManager } from "./service-manager";
import { probeOllama, type OllamaProbe } from "./ollama-probe";

type VoiceModule = {
  createVoiceSupervisor: (options?: { serviceRoot?: string; log?: (line: string) => void }) => {
    ensure: () => Promise<{
      mode: string;
      detail: string;
      child: { pid?: number } | null;
    }>;
    stopOwned: () => void;
    stopVerified: () => Promise<{ ok: boolean; summary: string }>;
  };
};

type WebModule = {
  createWebSupervisor: (options?: { serviceRoot?: string; log?: (line: string) => void }) => {
    ensure: () => Promise<{
      mode: string;
      detail: string;
      child: { pid?: number } | null;
      pid: number | null;
    }>;
    stopOwned: () => void;
    stopVerified: () => Promise<{ ok: boolean; summary: string }>;
  };
};

let singleton: Promise<ServiceManager> | null = null;
let voiceStopOwned = (): void => undefined;
let voiceStopVerified = async (): Promise<{
  ok: boolean;
  summary: string;
}> => ({
  ok: false,
  summary: "Voice is not running.",
});
let webStopOwned = (): void => undefined;
let webStopVerified = async (): Promise<{
  ok: boolean;
  summary: string;
}> => ({
  ok: false,
  summary: "Web search is not running.",
});

function repoRoot(appPath: string): string {
  if (existsSync(join(appPath, "scripts", "voice-supervisor.mjs"))) return appPath;
  const parent = join(appPath, "..", "..");
  if (existsSync(join(parent, "scripts", "voice-supervisor.mjs"))) return parent;
  return appPath;
}

function ollamaExecutable(): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    const candidate = join(dir, process.platform === "win32" ? "ollama.exe" : "ollama");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function spawnOllama(): { pid: number | null; kill: () => void; isRunning: () => boolean } {
  const executable = ollamaExecutable();
  if (!executable) {
    throw new Error("Ollama is not running and `ollama` was not found on PATH.");
  }
  const child: ChildProcess = spawn(executable, ["serve"], {
    stdio: "ignore",
    windowsHide: true,
  });
  let exited = false;
  child.once("error", () => {
    exited = true;
  });
  child.once("exit", () => {
    exited = true;
  });
  return {
    pid: child.pid ?? null,
    isRunning: () => !exited && !child.killed && child.exitCode === null && child.signalCode === null,
    kill: () => {
      if (!child.killed) child.kill();
    },
  };
}

async function waitOllama(): Promise<OllamaProbe> {
  const started = Date.now();
  let last: OllamaProbe = { state: "absent" };
  while (Date.now() - started < 30_000) {
    last = await probeOllama();
    if (last.state === "ready") return last;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return last;
}

export function serviceManager(appPath: string, options: { voiceEnabled?: boolean; webEnabled?: boolean } = {}): Promise<ServiceManager> {
  singleton ??= createManager(appPath, options).catch((error: unknown) => {
    singleton = null;
    throw error;
  });
  return singleton;
}

async function createManager(
  appPath: string,
  { voiceEnabled = true, webEnabled = true }: { voiceEnabled?: boolean; webEnabled?: boolean },
): Promise<ServiceManager> {
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
    if (!voiceEnabled) throw new Error("Voice is disabled for the hidden acceptance instance.");
    const loaded = (await import(/* @vite-ignore */ pathToFileURL(join(root, "scripts", "voice-supervisor.mjs")).href)) as VoiceModule;
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
    const message = error instanceof Error ? error.message : "Voice service could not be loaded.";
    ensureVoice = async () => ({
      mode: "unavailable",
      detail: `${message} Typed chat still works.`,
      pid: null,
      owned: false,
    });
  }

  let ensureWeb = async (): Promise<{
    mode: string;
    detail: string;
    pid: number | null;
    owned: boolean;
  }> => ({
    mode: "unavailable",
    detail: "Web search service could not be loaded. Typed chat still works.",
    pid: null,
    owned: false,
  });
  try {
    if (!webEnabled) throw new Error("Web search is disabled for the hidden acceptance instance.");
    const loaded = (await import(/* @vite-ignore */ pathToFileURL(join(root, "scripts", "web-supervisor.mjs")).href)) as WebModule;
    const web = loaded.createWebSupervisor({
      serviceRoot: join(root, "web-service"),
      log: (line) => console.log(line),
    });
    webStopOwned = () => web.stopOwned();
    webStopVerified = () => web.stopVerified();
    ensureWeb = async () => {
      const state = await web.ensure();
      return {
        mode: state.mode,
        detail: state.detail,
        pid: state.pid ?? state.child?.pid ?? null,
        owned: state.child !== null,
      };
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Web search service could not be loaded.";
    ensureWeb = async () => ({
      mode: "unavailable",
      detail: `${message} Typed chat still works.`,
      pid: null,
      owned: false,
    });
  }

  return createServiceManager({
    probeOllama,
    spawnOllama,
    waitOllama,
    ensureVoice: () => ensureVoice(),
    stopVoiceSpawned: () => voiceStopOwned(),
    stopVoiceVerified: () => voiceStopVerified(),
    ensureWeb: () => ensureWeb(),
    stopWebSpawned: () => webStopOwned(),
    stopWebVerified: () => webStopVerified(),
  });
}
