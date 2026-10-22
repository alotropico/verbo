import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWebSupervisor, parseWebBaseUrl, parseWindowsNetstat, readOrCreateToken, webTokenPath } from "./web-supervisor.mjs";

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

function compatible(ready = true, detail = undefined) {
  return healthResponse({
    identity: "verbo-web",
    apiVersion: "1",
    ready,
    engines: ["duckduckgo", "brave", "bing"],
    detail,
  });
}

function fakeChild(pid = 1234) {
  const handlers = {};
  return {
    pid,
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

function tokenFile() {
  const dir = mkdtempSync(join(tmpdir(), "verbo-web-token-"));
  return join(dir, "web-token");
}

describe("web supervisor", () => {
  it("keeps the token under the user Verbo folder", () => {
    expect(
      webTokenPath({
        LOCALAPPDATA: join("C:", "Users", "me", "AppData", "Local"),
      }),
    ).toBe(join("C:", "Users", "me", "AppData", "Local", "Verbo", "web-token"));
  });

  it("accepts only a loopback origin", () => {
    expect(parseWebBaseUrl("http://127.0.0.1:8766")).toBe("http://127.0.0.1:8766");
    expect(() => parseWebBaseUrl("http://localhost:8766")).toThrow(/127\.0\.0\.1/);
    expect(() => parseWebBaseUrl("http://127.0.0.1:8766/v1")).toThrow(/origin/);
  });

  it("handles token creation, reuse, and unusable tokens", () => {
    const file = tokenFile();
    const token1 = readOrCreateToken(file);
    expect(token1).toHaveLength(64);
    const token2 = readOrCreateToken(file);
    expect(token2).toBe(token1);

    writeFileSync(file, "short", "utf8");
    expect(() => readOrCreateToken(file)).toThrow(/unusable/);
  });

  it("reports unavailable if python is missing on free port", async () => {
    const web = createWebSupervisor({
      tokenPath: tokenFile(),
      fetchImpl: async () => refused(),
      pythonReady: false,
    });
    const state = await web.ensure();
    expect(state.mode).toBe("unavailable");
    expect(state.detail).toContain("Python is not installed");
    expect(state.pid).toBeNull();
  });

  it("does not spawn against an occupied foreign or unready port", async () => {
    let spawned = false;
    const foreignOccupant = createWebSupervisor({
      tokenPath: tokenFile(),
      fetchImpl: async () => healthResponse({ identity: "other-service" }),
      spawnImpl: () => {
        spawned = true;
        return fakeChild();
      },
    });
    const state1 = await foreignOccupant.ensure();
    expect(state1.mode).toBe("unavailable");
    expect(state1.detail).toContain("already bound");
    expect(spawned).toBe(false);

    // Unready verbo-web occupant
    const unreadyOccupant = createWebSupervisor({
      tokenPath: tokenFile(),
      fetchImpl: async () => compatible(false, "Initializing models"),
      spawnImpl: () => {
        spawned = true;
        return fakeChild();
      },
    });
    const state2 = await unreadyOccupant.ensure();
    expect(state2.mode).toBe("unavailable");
    expect(state2.detail).toContain("Initializing models");
    expect(spawned).toBe(false);
  });

  it("spawns child on free port and polls until ready, returning pid", async () => {
    let calls = 0;
    const child = fakeChild(5678);

    const web = createWebSupervisor({
      tokenPath: tokenFile(),
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return refused();
        if (calls === 2) return compatible(false);
        return compatible(true);
      },
      spawnImpl: () => child,
      pythonReady: true,
      readyTimeoutMs: 5000,
      pollMs: 10,
    });

    const state = await web.ensure();
    expect(state.mode).toBe("started");
    expect(state.child).toBe(child);
    expect(state.pid).toBe(5678);

    // Repeated ensure returns the already-owned child
    const stateAgain = await web.ensure();
    expect(stateAgain.mode).toBe("started");
    expect(stateAgain.child).toBe(child);
    expect(stateAgain.pid).toBe(5678);

    // Stop owned verifies stop
    const stopResult = await web.stopVerified();
    expect(stopResult.ok).toBe(true);
    expect(child.killed).toBe(true);
  });

  it("coalesces concurrent ensure calls into one spawn", async () => {
    let spawnCount = 0;
    const child = fakeChild(9999);

    let calls = 0;
    const web = createWebSupervisor({
      tokenPath: tokenFile(),
      fetchImpl: async () => {
        calls++;
        if (calls <= 2) return refused();
        return compatible(true);
      },
      spawnImpl: () => {
        spawnCount++;
        return child;
      },
      pythonReady: true,
      readyTimeoutMs: 5000,
      pollMs: 10,
    });

    const [res1, res2] = await Promise.all([web.ensure(), web.ensure()]);
    expect(spawnCount).toBe(1);
    expect(res1.mode).toBe("started");
    expect(res2.mode).toBe("started");
    expect(res1.pid).toBe(9999);
    expect(res2.pid).toBe(9999);
  });

  it("adopts a compatible service and reverifies identity before stopping", async () => {
    const killed = [];
    let spawned = false;
    let authValid = true;

    const web = createWebSupervisor({
      tokenPath: tokenFile(),
      fetchImpl: async () => {
        if (!authValid) return healthResponse({}, 401);
        return compatible(true);
      },
      spawnImpl: () => {
        spawned = true;
        return fakeChild();
      },
      pythonReady: true,
      pidLookup: async () => 4321,
      killPid: (pid) => killed.push(pid),
    });

    const state = await web.ensure();
    expect(state.mode).toBe("adopted");
    expect(state.pid).toBe(4321);
    expect(spawned).toBe(false);

    // If auth identity check fails before stopVerified, it refuses to kill
    authValid = false;
    const failedStop = await web.stopVerified();
    expect(failedStop.ok).toBe(false);
    expect(failedStop.summary).toContain("identity could not be verified");
    expect(killed).toEqual([]);

    // Restore auth: stopVerified succeeds
    authValid = true;
    const web2 = createWebSupervisor({
      tokenPath: tokenFile(),
      fetchImpl: async () => compatible(true),
      pidLookup: async () => 4321,
      killPid: (pid) => killed.push(pid),
    });
    await web2.ensure();
    const okStop = await web2.stopVerified();
    expect(okStop.ok).toBe(true);
    expect(killed).toEqual([4321]);
  });

  it("parses windows netstat listening port", () => {
    const stdout = `
  TCP    127.0.0.1:8766         0.0.0.0:0              LISTENING       12345
  TCP    [::]:8766              [::]:0                 LISTENING       67890
    `;
    expect(parseWindowsNetstat(stdout, 8766)).toBe(12345);
  });

  it("retains an unresponsive owned child until it can be stopped", async () => {
    const child = fakeChild();
    let calls = 0;
    let spawns = 0;
    const web = createWebSupervisor({
      tokenPath: tokenFile(),
      pythonReady: true,
      fetchImpl: async () => (++calls === 2 ? compatible() : refused()),
      spawnImpl: () => {
        spawns++;
        return child;
      },
    });
    await web.ensure();
    const retry = await web.ensure();
    expect(retry).toMatchObject({ mode: "unavailable", child, pid: child.pid });
    expect(spawns).toBe(1);
    expect((await web.stopVerified()).ok).toBe(true);
    expect(child.killed).toBe(true);
  });

  it("cancels a pending probe before Stop completes, and can start again", async () => {
    let release = () => undefined;
    let calls = 0;
    let spawns = 0;
    const web = createWebSupervisor({
      tokenPath: tokenFile(),
      pythonReady: true,
      fetchImpl: async () => {
        calls++;
        if (calls === 1)
          await new Promise((resolve) => {
            release = resolve;
          });
        if (calls <= 2) return refused();
        return compatible();
      },
      spawnImpl: () => {
        spawns++;
        return fakeChild();
      },
    });
    const pending = web.ensure();
    expect((await web.stopVerified()).ok).toBe(true);
    expect((await pending).detail).toContain("cancelled");
    release();
    await Promise.resolve();
    expect(spawns).toBe(0);
    expect((await web.ensure()).mode).toBe("started");
    expect(spawns).toBe(1);
    web.stopOwned();
  });

  it("does not adopt a listener after Stop cancels pending PID lookup", async () => {
    let lookupStarted;
    const enteredLookup = new Promise((resolve) => {
      lookupStarted = resolve;
    });
    let release;
    const lookup = new Promise((resolve) => {
      release = resolve;
    });
    const killed = [];
    const web = createWebSupervisor({
      tokenPath: tokenFile(),
      fetchImpl: async () => compatible(),
      pidLookup: async () => {
        lookupStarted();
        return lookup;
      },
      killPid: (pid) => killed.push(pid),
    });
    const pending = web.ensure();
    await enteredLookup;
    await web.stopVerified();
    release(9876);
    expect((await pending).detail).toContain("cancelled");
    expect(killed).toEqual([]);
  });

  it.each(["missing", "corrupt"])("refuses adopted termination with a %s token", async (kind) => {
    const file = tokenFile();
    const killed = [];
    let probes = 0;
    const web = createWebSupervisor({
      tokenPath: file,
      fetchImpl: async () => {
        probes++;
        return compatible();
      },
      pidLookup: async () => 4321,
      killPid: (pid) => killed.push(pid),
    });
    await web.ensure();
    if (kind === "missing") rmSync(file);
    else writeFileSync(file, "short");
    expect((await web.stopVerified()).ok).toBe(false);
    expect(killed).toEqual([]);
    expect(probes).toBe(1);
  });

  it("retains ownership when killing the child fails", async () => {
    const child = fakeChild();
    child.kill = () => false;
    let probes = 0;
    let spawns = 0;
    const web = createWebSupervisor({
      tokenPath: tokenFile(),
      pythonReady: true,
      fetchImpl: async () => (++probes === 1 ? refused() : compatible()),
      spawnImpl: () => {
        spawns++;
        return child;
      },
    });
    await web.ensure();
    expect((await web.stopVerified()).ok).toBe(false);
    expect((await web.ensure()).child).toBe(child);
    expect(spawns).toBe(1);
  });
});
