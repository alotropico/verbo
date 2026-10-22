import type { OllamaProbe } from "./ollama-probe";

export type ManagedServiceName = "ollama" | "voice" | "web";

export type ServiceView = {
  name: ManagedServiceName;
  state: "stopped" | "starting" | "ready" | "error";
  owned: boolean;
  reused: boolean;
  identity: string | null;
  pid: number | null;
  error: string | null;
  suppressed: boolean;
  detail: string;
};

export type ServiceManager = {
  boot(): Promise<ServiceView>;
  ensureVoice(): Promise<ServiceView>;
  ensureWeb(): Promise<ServiceView>;
  start(name: ManagedServiceName): Promise<ServiceView>;
  stop(name: ManagedServiceName): Promise<{ ok: true; service: ServiceView } | { ok: false; summary: string; service: ServiceView }>;
  shutdown(): Promise<void>;
  snapshot(): { ollama: ServiceView; voice: ServiceView; web: ServiceView };
};

type Child = { pid: number | null; kill: () => void; isRunning: () => boolean };

const stopped = (name: ManagedServiceName): ServiceView => ({
  name,
  state: "stopped",
  owned: false,
  reused: false,
  identity: null,
  pid: null,
  error: null,
  suppressed: false,
  detail: `${name} is stopped.`,
});

export function createServiceManager(deps: {
  probeOllama: () => Promise<OllamaProbe>;
  spawnOllama: () => Child;
  waitOllama: () => Promise<OllamaProbe>;
  pause?: (ms: number) => Promise<void>;
  ensureVoice: () => Promise<{
    mode: string;
    detail: string;
    pid: number | null;
    owned: boolean;
  }>;
  stopVoiceSpawned: () => void;
  stopVoiceVerified: () => Promise<{ ok: boolean; summary: string }>;
  ensureWeb?: () => Promise<{
    mode: string;
    detail: string;
    pid: number | null;
    owned: boolean;
  }>;
  stopWebSpawned?: () => void;
  stopWebVerified?: () => Promise<{ ok: boolean; summary: string }>;
}): ServiceManager {
  let ollama = stopped("ollama");
  let voice = stopped("voice");
  let web = stopped("web");
  let ollamaChild: Child | null = null;
  let ollamaStart: Promise<ServiceView> | null = null;
  let voiceStart: Promise<ServiceView> | null = null;
  let webStart: Promise<ServiceView> | null = null;
  let webStop: Promise<Awaited<ReturnType<ServiceManager["stop"]>>> | null = null;
  let webGeneration = 0;
  let shuttingDown = false;

  const interrupted = (): boolean => shuttingDown || ollama.suppressed;
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function checkExisting(): Promise<OllamaProbe> {
    let unresponsive: Extract<OllamaProbe, { state: "unresponsive" }> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await deps.probeOllama();
      if (interrupted() || result.state === "ready") return result;
      if (result.state === "unresponsive") unresponsive = result;
      if (attempt < 2) await pause(1000);
      if (interrupted()) break;
    }
    return unresponsive ?? { state: "absent" };
  }

  function unavailable(detail: string): ServiceView {
    const owned = ollamaChild?.isRunning() ?? false;
    if (!owned) ollamaChild = null;
    ollama = { ...ollama, state: "error", owned, pid: owned ? ollamaChild!.pid : null, error: detail, detail };
    return ollama;
  }

  async function ensureOllama(): Promise<ServiceView> {
    if (interrupted()) return ollama;
    if (ollamaStart) return ollamaStart;
    ollamaStart = (async () => {
      ollama = { ...ollama, state: "starting", error: null };
      if (ollamaChild && !ollamaChild.isRunning()) ollamaChild = null;
      const existing = await checkExisting();
      if (interrupted()) return ollama;
      if (ollamaChild && !ollamaChild.isRunning()) ollamaChild = null;
      if (existing.state === "ready" && ollamaChild) {
        ollama = {
          ...ollama,
          state: "ready",
          identity: existing.version,
          pid: ollamaChild.pid,
          suppressed: false,
          detail: "Verbo started Ollama.",
        };
        return ollama;
      }
      if (existing.state === "ready") {
        ollama = {
          ...stopped("ollama"),
          state: "ready",
          reused: true,
          identity: existing.version,
          detail: "Connected to an existing Ollama service.",
        };
        return ollama;
      }
      if (existing.state === "unresponsive")
        return unavailable(`${existing.detail} No additional Ollama process was started. Try Start again when the service responds.`);
      if (ollamaChild)
        return unavailable("The Ollama process Verbo started is still running but is not ready. No additional process was started.");
      try {
        ollamaChild = deps.spawnOllama();
        ollama = { ...ollama, owned: true, reused: false, pid: ollamaChild.pid };
      } catch (error) {
        ollama = {
          ...stopped("ollama"),
          state: "error",
          error: error instanceof Error ? error.message : "Ollama did not start.",
          detail: "Ollama did not start.",
        };
        return ollama;
      }
      const probed = await deps.waitOllama();
      if (interrupted()) return ollama;
      if (probed.state !== "ready") return unavailable(probed.state === "unresponsive" ? probed.detail : "Timed out waiting for Ollama.");
      const owned = ollamaChild?.isRunning() ?? false;
      if (!owned) ollamaChild = null;
      ollama = {
        ...stopped("ollama"),
        state: "ready",
        owned,
        reused: !owned,
        identity: probed.version,
        pid: ollamaChild?.pid ?? null,
        detail: owned ? "Verbo started Ollama." : "Connected to an existing Ollama service.",
      };
      return ollama;
    })().finally(() => {
      ollamaStart = null;
    });
    return ollamaStart;
  }

  async function ensureVoiceService(): Promise<ServiceView> {
    if (voice.suppressed) {
      return {
        ...voice,
        state: "stopped",
        detail: "Voice is stopped. Start it to use voice.",
      };
    }
    if (voiceStart) return voiceStart;
    voiceStart = (async () => {
      voice = { ...voice, state: "starting", error: null, suppressed: false };
      const result = await deps.ensureVoice();
      const ready = result.mode === "started" || result.mode === "adopted" || result.mode === "reused";
      voice = {
        name: "voice",
        state: ready ? "ready" : "error",
        owned: result.owned,
        reused: result.mode === "adopted" || result.mode === "reused",
        identity: ready ? "verbo-voice" : null,
        pid: result.pid,
        error: ready ? null : result.detail,
        suppressed: false,
        detail: result.detail,
      };
      return voice;
    })().finally(() => {
      voiceStart = null;
    });
    return voiceStart;
  }

  async function ensureWebService(): Promise<ServiceView> {
    if (shuttingDown || web.suppressed) {
      return {
        ...web,
        state: "stopped",
        detail: "Web search is stopped. Start it to search.",
      };
    }
    if (webStart) return webStart;
    const currentGen = ++webGeneration;
    webStart = (async () => {
      web = { ...web, state: "starting", error: null, suppressed: false };
      if (!deps.ensureWeb) {
        web = {
          name: "web",
          state: "error",
          owned: false,
          reused: false,
          identity: null,
          pid: null,
          error: "Web search supervisor is not available.",
          suppressed: false,
          detail: "Web search supervisor is not available. Typed chat still works.",
        };
        return web;
      }
      const result = await deps.ensureWeb();
      if (shuttingDown || web.suppressed || webGeneration !== currentGen) {
        deps.stopWebSpawned?.();
        return web;
      }
      const ready = result.mode === "started" || result.mode === "adopted" || result.mode === "reused";
      web = {
        name: "web",
        state: ready ? "ready" : "error",
        owned: result.owned,
        reused: result.mode === "adopted" || result.mode === "reused",
        identity: ready ? "verbo-web" : null,
        pid: result.pid,
        error: ready ? null : result.detail,
        suppressed: false,
        detail: result.detail,
      };
      return web;
    })().finally(() => {
      webStart = null;
    });
    return webStart;
  }

  async function stopWebService(): Promise<Awaited<ReturnType<ServiceManager["stop"]>>> {
    if (webStop) return webStop;
    webGeneration++;
    web = { ...web, suppressed: true };
    const pendingStart = webStart;
    webStop = (async (): Promise<Awaited<ReturnType<ServiceManager["stop"]>>> => {
      deps.stopWebSpawned?.();
      let stoppedWeb: { ok: boolean; summary: string };
      try {
        stoppedWeb = deps.stopWebVerified ? await deps.stopWebVerified() : { ok: true, summary: "Stopped web." };
      } catch (error) {
        stoppedWeb = { ok: false, summary: error instanceof Error ? error.message : "Web search could not be stopped." };
      }
      await pendingStart?.catch(() => undefined);
      web = {
        ...stopped("web"),
        suppressed: true,
        detail: stoppedWeb.ok ? "Web search is stopped. Start it to search." : stoppedWeb.summary,
        error: stoppedWeb.ok ? null : stoppedWeb.summary,
      };
      return stoppedWeb.ok ? { ok: true, service: web } : { ok: false, summary: stoppedWeb.summary, service: web };
    })().finally(() => {
      webStop = null;
    });
    return webStop;
  }

  return {
    boot: () => ensureOllama(),
    ensureVoice: () => ensureVoiceService(),
    ensureWeb: () => ensureWebService(),
    snapshot: () => ({ ollama, voice, web }),
    async start(name) {
      if (name === "ollama") {
        ollama = { ...ollama, suppressed: false };
        return ensureOllama();
      }
      if (name === "voice") {
        voice = { ...voice, suppressed: false };
        return ensureVoiceService();
      }
      if (shuttingDown) return web;
      if (webStop) await webStop;
      if (shuttingDown) return web;
      web = { ...web, suppressed: false };
      return ensureWebService();
    },
    async stop(name) {
      if (name === "ollama") {
        ollama = { ...ollama, suppressed: true };
        if (ollamaChild) {
          ollamaChild.kill();
          ollamaChild = null;
          ollama = {
            ...stopped("ollama"),
            suppressed: true,
            detail: "Ollama is stopped. Start it to send this message.",
          };
          return { ok: true, service: ollama };
        }
        if (ollama.reused || ollama.state === "ready") {
          ollama = {
            ...ollama,
            suppressed: true,
            state: "stopped",
            detail:
              "Ollama was already running for other clients. Verbo could not identify its process, so it was left running. New requests stay paused until Start.",
          };
          return {
            ok: false,
            summary: ollama.detail,
            service: ollama,
          };
        }
        ollama = {
          ...stopped("ollama"),
          suppressed: true,
          detail: "Ollama is stopped. Start it to send this message.",
        };
        return { ok: true, service: ollama };
      }
      if (name === "voice") {
        voice = { ...voice, suppressed: true };
        const stoppedVoice = await deps.stopVoiceVerified();
        deps.stopVoiceSpawned();
        voice = {
          ...stopped("voice"),
          suppressed: true,
          detail: stoppedVoice.ok ? "Voice is stopped. Start it to use voice." : stoppedVoice.summary,
          error: stoppedVoice.ok ? null : stoppedVoice.summary,
          state: "stopped",
        };
        return stoppedVoice.ok ? { ok: true, service: voice } : { ok: false, summary: stoppedVoice.summary, service: voice };
      }
      return stopWebService();
    },
    async shutdown() {
      shuttingDown = true;
      if (ollamaChild) {
        ollamaChild.kill();
        ollamaChild = null;
      }
      deps.stopVoiceSpawned();
      await stopWebService();
    },
  };
}
