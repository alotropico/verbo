import { describe, expect, it } from "vitest";
import { createServiceManager } from "./service-manager";
import type { OllamaProbe } from "./ollama-probe";

const ready: OllamaProbe = { state: "ready", version: "test" };
const absent: OllamaProbe = { state: "absent" };

function harness(options?: {
  ollamaUp?: boolean;
  ensureWeb?: () => Promise<{
    mode: string;
    detail: string;
    pid: number | null;
    owned: boolean;
  }>;
  stopWebVerified?: () => Promise<{ ok: boolean; summary: string }>;
}): {
  manager: ReturnType<typeof createServiceManager>;
  counts: () => {
    spawned: number;
    killed: number;
    voiceStarts: number;
    webStarts: number;
    webKills: number;
  };
} {
  let up = options?.ollamaUp ?? false;
  let spawned = 0;
  let killed = 0;
  let voiceStarts = 0;
  let webStarts = 0;
  let webKills = 0;
  let running = false;
  const manager = createServiceManager({
    pause: async () => undefined,
    probeOllama: async () => (up ? ready : absent),
    spawnOllama: () => {
      spawned += 1;
      up = true;
      running = true;
      return {
        pid: 41,
        isRunning: () => running,
        kill: () => {
          killed += 1;
          up = false;
          running = false;
        },
      };
    },
    waitOllama: async () => ready,
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
    ensureWeb:
      options?.ensureWeb ??
      (async () => {
        webStarts += 1;
        return {
          mode: "started",
          detail: "Web started.",
          pid: 43,
          owned: true,
        };
      }),
    stopWebSpawned: () => {
      webKills += 1;
    },
    stopWebVerified: options?.stopWebVerified ?? (async () => ({ ok: true, summary: "Stopped web." })),
  });
  return {
    manager,
    counts: () => ({ spawned, killed, voiceStarts, webStarts, webKills }),
  };
}

describe("service manager", () => {
  it("starts Ollama once and leaves voice and web stopped until requested", async () => {
    const { manager, counts } = harness();
    const [first, second] = await Promise.all([manager.boot(), manager.start("ollama")]);
    expect(first.state).toBe("ready");
    expect(second.owned).toBe(true);
    expect(counts().spawned).toBe(1);
    expect(manager.snapshot().voice.state).toBe("stopped");
    expect(manager.snapshot().web.state).toBe("stopped");
    expect(counts().voiceStarts).toBe(0);
    expect(counts().webStarts).toBe(0);
    const webView = await manager.ensureWeb();
    expect(webView.state).toBe("ready");
    expect(counts().webStarts).toBe(1);
  });

  it("coalesces concurrent web starts and does not duplicate launches", async () => {
    const { manager, counts } = harness();
    const [first, second] = await Promise.all([manager.ensureWeb(), manager.ensureWeb()]);
    expect(first.state).toBe("ready");
    expect(second.state).toBe("ready");
    expect(counts().webStarts).toBe(1);
    expect(manager.snapshot().web.pid).toBe(43);
  });

  it("does not restart a service stopped for this session until explicit start", async () => {
    const { manager, counts } = harness({ ollamaUp: true });
    await manager.boot();
    expect(manager.snapshot().ollama.reused).toBe(true);
    const stopped = await manager.stop("ollama");
    expect(stopped.ok).toBe(false);

    // Voice suppression
    await manager.ensureVoice();
    expect(counts().voiceStarts).toBe(1);
    await manager.stop("voice");
    await manager.ensureVoice();
    expect(counts().voiceStarts).toBe(1);
    await manager.start("voice");
    expect(counts().voiceStarts).toBe(2);

    // Web suppression
    await manager.ensureWeb();
    expect(counts().webStarts).toBe(1);
    await manager.stop("web");
    expect(manager.snapshot().web.state).toBe("stopped");
    const suppressedWeb = await manager.ensureWeb();
    expect(suppressedWeb.state).toBe("stopped");
    expect(suppressedWeb.suppressed).toBe(true);
    expect(counts().webStarts).toBe(1);
    const restartedWeb = await manager.start("web");
    expect(restartedWeb.state).toBe("ready");
    expect(counts().webStarts).toBe(2);
  });

  it("handles stop during web startup and triggers stopWebSpawned via cancellation guard", async () => {
    let releaseWeb: (val: { mode: string; detail: string; pid: number; owned: boolean }) => void = () => undefined;
    const { manager, counts } = harness({
      ensureWeb: () =>
        new Promise((resolve) => {
          releaseWeb = resolve;
        }),
    });

    const pending = manager.ensureWeb();
    const stopPromise = manager.stop("web");
    releaseWeb({ mode: "started", detail: "Web started late.", pid: 99, owned: true });
    await pending;
    await stopPromise;
    expect(counts().webKills).toBeGreaterThanOrEqual(1);
    expect(manager.snapshot().web.state).toBe("stopped");
  });

  it("handles supervisor offline or missing error cleanly without affecting Ollama", async () => {
    const { manager } = harness({
      ensureWeb: async () => ({
        mode: "unavailable",
        detail: "Python not found. Typed chat still works.",
        pid: null,
        owned: false,
      }),
    });
    await manager.boot();
    expect(manager.snapshot().ollama.state).toBe("ready");
    const webView = await manager.ensureWeb();
    expect(webView.state).toBe("error");
    expect(webView.error).toContain("Python not found");
    expect(manager.snapshot().ollama.state).toBe("ready");
  });

  it("waits for cancelled startup before finishing shutdown and never restarts afterward", async () => {
    let release: (value: { mode: string; detail: string; pid: number; owned: boolean }) => void = () => undefined;
    let starts = 0;
    const { manager } = harness({
      ensureWeb: () => {
        starts++;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const pending = manager.ensureWeb();
    let finished = false;
    const shutdown = manager.shutdown().then(() => {
      finished = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    release({ mode: "started", detail: "late", pid: 99, owned: true });
    await Promise.all([pending, shutdown]);
    expect(manager.snapshot().web.state).toBe("stopped");
    await manager.start("web");
    await manager.ensureWeb();
    expect(starts).toBe(1);
  });

  it("serializes a new Start behind Stop of an earlier startup", async () => {
    let release: (value: { mode: string; detail: string; pid: number; owned: boolean }) => void = () => undefined;
    let starts = 0;
    const { manager } = harness({
      ensureWeb: async () => {
        if (++starts === 1)
          return new Promise((resolve) => {
            release = resolve;
          });
        return { mode: "started", detail: "restarted", pid: 100, owned: true };
      },
    });
    const first = manager.ensureWeb();
    const stop = manager.stop("web");
    const restart = manager.start("web");
    expect(starts).toBe(1);
    release({ mode: "started", detail: "late", pid: 99, owned: true });
    await Promise.all([first, stop]);
    expect((await restart).pid).toBe(100);
    expect(manager.snapshot().web.state).toBe("ready");
  });

  it("shuts down only the Ollama and web processes this app spawned", async () => {
    const { manager, counts } = harness();
    await manager.boot();
    await manager.ensureWeb();
    expect(counts().spawned).toBe(1);
    expect(counts().webStarts).toBe(1);
    await manager.shutdown();
    expect(counts().killed).toBe(1);
    expect(counts().webKills).toBe(1);

    const reused = harness({ ollamaUp: true });
    await reused.manager.boot();
    await reused.manager.shutdown();
    expect(reused.counts().killed).toBe(0);
  });
});
