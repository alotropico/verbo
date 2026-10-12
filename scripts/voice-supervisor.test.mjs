import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLauncherShutdown,
  createVoiceSupervisor,
  parseVoiceBaseUrl,
  parseWindowsNetstat,
  readOrCreateToken,
  voiceTokenPath,
} from "./voice-supervisor.mjs";
import { bootDev } from "./dev-boot.mjs";

function refused() {
  const error = new TypeError("connect");
  error.cause = { code: "ECONNREFUSED" };
  throw error;
}

function healthResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function compatible() {
  return healthResponse({ identity: "verbo-voice", apiVersion: "1" });
}

function fakeChild() {
  const handlers = {};
  return {
    killed: false,
    exitCode: null,
    stdout: null,
    stderr: null,
    kill() {
      this.killed = true;
      this.exitCode = 1;
      handlers.exit?.();
    },
    on(event, fn) {
      handlers[event] = fn;
    },
  };
}

describe("voice supervisor", () => {
  it("keeps the token under the user Verbo folder", () => {
    expect(
      voiceTokenPath({
        LOCALAPPDATA: join("C:", "Users", "me", "AppData", "Local"),
      }),
    ).toBe(
      join("C:", "Users", "me", "AppData", "Local", "Verbo", "voice-token"),
    );
  });

  it("accepts only a loopback origin", () => {
    expect(parseVoiceBaseUrl("http://127.0.0.1:8765")).toBe(
      "http://127.0.0.1:8765",
    );
    expect(() => parseVoiceBaseUrl("http://localhost:8765")).toThrow(
      /127\.0\.0\.1/,
    );
    expect(() => parseVoiceBaseUrl("http://127.0.0.1:8765/v1")).toThrow(
      /origin/,
    );
  });

  it("adopts a compatible service and stops that process on shutdown", async () => {
    const killed = [];
    let spawned = 0;
    const voice = createVoiceSupervisor({
      tokenPath: tokenFile(),
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async () => compatible(),
      spawnImpl: () => {
        spawned += 1;
        throw new Error("spawned");
      },
      pythonReady: true,
      pidLookup: async () => 4242,
      killPid: (pid) => {
        killed.push(pid);
      },
    });
    const state = await voice.ensure();
    expect(state.mode).toBe("adopted");
    expect(spawned).toBe(0);
    voice.stopOwned();
    voice.stopOwned();
    expect(killed).toEqual([4242]);
  });

  it("leaves a compatible service running when its process id is unknown", async () => {
    const killed = [];
    const voice = createVoiceSupervisor({
      tokenPath: tokenFile(),
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async () => compatible(),
      spawnImpl: () => {
        throw new Error("spawned");
      },
      pythonReady: true,
      pidLookup: async () => null,
      killPid: (pid) => {
        killed.push(pid);
      },
    });
    const state = await voice.ensure();
    expect(state.mode).toBe("reused");
    voice.stopOwned();
    expect(killed).toEqual([]);
  });

  it("reads the loopback listener from Windows netstat output", () => {
    const stdout = [
      "  TCP    0.0.0.0:8765           0.0.0.0:0              LISTENING       9",
      "  TCP    127.0.0.1:8765         0.0.0.0:0              LISTENING       4242",
      "  TCP    127.0.0.1:80           0.0.0.0:0              LISTENING       7",
    ].join("\n");
    expect(parseWindowsNetstat(stdout, 8765)).toBe(4242);
  });

  it("leaves an incompatible occupant running", async () => {
    let spawned = 0;
    const voice = createVoiceSupervisor({
      tokenPath: tokenFile(),
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async () =>
        healthResponse({ identity: "other", apiVersion: "9" }),
      spawnImpl: () => {
        spawned += 1;
        return fakeChild();
      },
      pythonReady: true,
    });
    const state = await voice.ensure();
    expect(state.mode).toBe("unavailable");
    expect(state.detail).toMatch(/left running/);
    expect(spawned).toBe(0);
  });

  it("stops the child it started when readiness times out", async () => {
    const child = fakeChild();
    const voice = createVoiceSupervisor({
      tokenPath: tokenFile(),
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async () => {
        refused();
      },
      spawnImpl: () => child,
      pythonReady: true,
      readyTimeoutMs: 80,
      pollMs: 20,
      log: () => {},
    });
    const state = await voice.ensure();
    expect(state.mode).toBe("unavailable");
    expect(child.killed).toBe(true);
  });

  it("keeps an owned child until stop and then kills only that child", async () => {
    const child = fakeChild();
    let probes = 0;
    const voice = createVoiceSupervisor({
      tokenPath: tokenFile(),
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async () => {
        probes += 1;
        if (probes === 1) refused();
        return compatible();
      },
      spawnImpl: () => child,
      pythonReady: true,
      log: () => {},
    });
    const state = await voice.ensure();
    expect(state.mode).toBe("started");
    expect(child.killed).toBe(false);
    voice.stopOwned();
    expect(child.killed).toBe(true);
    voice.stopOwned();
    expect(child.killed).toBe(true);
  });

  it("still boots typed chat when voice is unavailable", async () => {
    let dev = 0;
    const state = await bootDev({
      ensureOllama: async () => {},
      verifyModel: async () => {},
      ensureVoice: async () => ({
        mode: "unavailable",
        detail:
          "Voice service Python is not installed. Typed chat still works.",
        child: null,
      }),
      runDev: () => {
        dev += 1;
      },
      log: () => {},
    });
    expect(state.mode).toBe("unavailable");
    expect(dev).toBe(1);
  });

  it("shuts down the owned voice and ollama without a second exit", () => {
    const calls = [];
    const shutdown = createLauncherShutdown({
      stopVoice: () => calls.push("voice"),
      stopOllama: () => calls.push("ollama"),
      exit: (code) => calls.push(`exit:${code}`),
      log: () => {},
    });
    shutdown(0);
    shutdown(1);
    expect(calls).toEqual(["voice", "ollama", "exit:0"]);
  });
});

function tokenFile() {
  const dir = mkdtempSync(join(tmpdir(), "verbo-voice-"));
  const file = join(dir, "voice-token");
  writeFileSync(file, "a".repeat(32));
  return file;
}

describe("voice token file", () => {
  it("refuses to replace an unusable token", () => {
    const dir = mkdtempSync(join(tmpdir(), "verbo-voice-"));
    const file = join(dir, "voice-token");
    writeFileSync(file, "short");
    expect(() => readOrCreateToken(file)).toThrow(/unusable/);
    rmSync(dir, { recursive: true });
  });
});
