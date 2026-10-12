export type ManagedServiceName = "ollama" | "voice";

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
  start(name: ManagedServiceName): Promise<ServiceView>;
  stop(
    name: ManagedServiceName,
  ): Promise<
    | { ok: true; service: ServiceView }
    | { ok: false; summary: string; service: ServiceView }
  >;
  shutdown(): Promise<void>;
  snapshot(): { ollama: ServiceView; voice: ServiceView };
};

type Child = { pid: number | null; kill: () => void };

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
  probeOllama: () => Promise<{ ok: boolean; version: string | null }>;
  spawnOllama: () => Child;
  waitOllama: () => Promise<boolean>;
  ensureVoice: () => Promise<{
    mode: string;
    detail: string;
    pid: number | null;
    owned: boolean;
  }>;
  stopVoiceSpawned: () => void;
  stopVoiceVerified: () => Promise<{ ok: boolean; summary: string }>;
}): ServiceManager {
  let ollama = stopped("ollama");
  let voice = stopped("voice");
  let ollamaChild: Child | null = null;
  let ollamaStart: Promise<ServiceView> | null = null;
  let voiceStart: Promise<ServiceView> | null = null;

  async function ensureOllama(): Promise<ServiceView> {
    if (ollama.suppressed) return ollama;
    if (ollamaStart) return ollamaStart;
    ollamaStart = (async () => {
      ollama = { ...ollama, state: "starting", error: null };
      const existing = await deps.probeOllama();
      if (existing.ok && ollama.owned && ollamaChild) {
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
      if (existing.ok) {
        if (ollamaChild) {
          ollamaChild.kill();
          ollamaChild = null;
        }
        ollama = {
          ...stopped("ollama"),
          state: "ready",
          reused: true,
          identity: existing.version,
          detail: "Connected to an existing Ollama service.",
        };
        return ollama;
      }
      try {
        ollamaChild = deps.spawnOllama();
      } catch (error) {
        ollama = {
          ...stopped("ollama"),
          state: "error",
          error:
            error instanceof Error ? error.message : "Ollama did not start.",
          detail: "Ollama did not start.",
        };
        return ollama;
      }
      const ready = await deps.waitOllama();
      if (!ready) {
        const raced = await deps.probeOllama();
        ollamaChild?.kill();
        ollamaChild = null;
        if (raced.ok) {
          ollama = {
            ...stopped("ollama"),
            state: "ready",
            reused: true,
            identity: raced.version,
            detail: "Connected to an existing Ollama service.",
          };
          return ollama;
        }
        ollama = {
          ...stopped("ollama"),
          state: "error",
          error: "Timed out waiting for Ollama.",
          detail: "Timed out waiting for Ollama.",
        };
        return ollama;
      }
      const probed = await deps.probeOllama();
      ollama = {
        ...stopped("ollama"),
        state: "ready",
        owned: true,
        identity: probed.version,
        pid: ollamaChild?.pid ?? null,
        detail: "Verbo started Ollama.",
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
      const ready =
        result.mode === "started" ||
        result.mode === "adopted" ||
        result.mode === "reused";
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

  return {
    boot: () => ensureOllama(),
    ensureVoice: () => ensureVoiceService(),
    snapshot: () => ({ ollama, voice }),
    async start(name) {
      if (name === "ollama") {
        ollama = { ...ollama, suppressed: false };
        return ensureOllama();
      }
      voice = { ...voice, suppressed: false };
      return ensureVoiceService();
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
      voice = { ...voice, suppressed: true };
      const stoppedVoice = await deps.stopVoiceVerified();
      deps.stopVoiceSpawned();
      voice = {
        ...stopped("voice"),
        suppressed: true,
        detail: stoppedVoice.ok
          ? "Voice is stopped. Start it to use voice."
          : stoppedVoice.summary,
        error: stoppedVoice.ok ? null : stoppedVoice.summary,
        state: "stopped",
      };
      return stoppedVoice.ok
        ? { ok: true, service: voice }
        : { ok: false, summary: stoppedVoice.summary, service: voice };
    },
    async shutdown() {
      if (ollama.owned && ollamaChild) {
        ollamaChild.kill();
        ollamaChild = null;
      }
      deps.stopVoiceSpawned();
    },
  };
}
