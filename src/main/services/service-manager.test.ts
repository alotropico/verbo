import { describe, expect, it } from "vitest";
import { createServiceManager } from "./service-manager";

function harness(options?: { ollamaUp?: boolean }): {
  manager: ReturnType<typeof createServiceManager>;
  counts: () => { spawned: number; killed: number; voiceStarts: number };
} {
  let up = options?.ollamaUp ?? false;
  let spawned = 0;
  let killed = 0;
  let voiceStarts = 0;
  const manager = createServiceManager({
    probeOllama: async () => ({
      ok: up,
      version: up ? "test" : null,
    }),
    spawnOllama: () => {
      spawned += 1;
      up = true;
      return {
        pid: 41,
        kill: () => {
          killed += 1;
          up = false;
        },
      };
    },
    waitOllama: async () => true,
    ensureVoice: async () => {
      voiceStarts += 1;
      return {
        mode: "started",
        detail: "Voice started.",
        pid: 42,
        owned: true,
      };
    },
    stopVoiceSpawned: () => undefined,
    stopVoiceVerified: async () => ({ ok: true, summary: "Stopped voice." }),
  });
  return {
    manager,
    counts: () => ({ spawned, killed, voiceStarts }),
  };
}

describe("service manager", () => {
  it("starts Ollama once and leaves voice stopped until requested", async () => {
    const { manager, counts } = harness();
    const [first, second] = await Promise.all([
      manager.boot(),
      manager.start("ollama"),
    ]);
    expect(first.state).toBe("ready");
    expect(second.owned).toBe(true);
    expect(counts().spawned).toBe(1);
    expect(manager.snapshot().voice.state).toBe("stopped");
    expect(counts().voiceStarts).toBe(0);
    await manager.ensureVoice();
    expect(counts().voiceStarts).toBe(1);
  });

  it("does not restart a service stopped for this session", async () => {
    const { manager, counts } = harness({ ollamaUp: true });
    await manager.boot();
    expect(manager.snapshot().ollama.reused).toBe(true);
    const stopped = await manager.stop("ollama");
    expect(stopped.ok).toBe(false);
    await manager.ensureVoice();
    expect(counts().voiceStarts).toBe(1);
    await manager.stop("voice");
    await manager.ensureVoice();
    expect(counts().voiceStarts).toBe(1);
    await manager.start("voice");
    expect(counts().voiceStarts).toBe(2);
  });

  it("shuts down only the Ollama process this app spawned", async () => {
    const { manager, counts } = harness();
    await manager.boot();
    await manager.shutdown();
    expect(counts().killed).toBe(1);
    const reused = harness({ ollamaUp: true });
    await reused.manager.boot();
    await reused.manager.shutdown();
    expect(reused.counts().killed).toBe(0);
  });
});
