import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsResource } from "./settings-resource";
import { SettingsSession } from "./settings-session";

afterEach(() => vi.useRealTimers());

describe("settings presentation cache", () => {
  it("shares in-flight reads and reuses data across views until its TTL expires", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => ["files", "environment"]);
    const session = new SettingsSession();
    const first = session.resource("commands", load);
    expect(first.snapshot()).toEqual({ data: null, loading: true, error: "" });
    await Promise.all([first.load(), session.resource("commands", load).load()]);
    await first.load();
    expect(load).toHaveBeenCalledTimes(1);
    expect(first.snapshot().loading).toBe(false);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(load).toHaveBeenCalledTimes(1);
    await first.load();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("refreshes active data once after invalidation and defers inactive reads until return", async () => {
    const load = vi.fn(async () => load.mock.calls.length);
    const session = new SettingsSession();
    const resource = session.resource("files", load);
    await resource.load();
    const unsubscribe = resource.subscribe(() => undefined);
    session.invalidateResources("files");
    await resource.load();
    expect(resource.snapshot().data).toBe(2);
    unsubscribe();
    session.invalidateResources("files");
    expect(load).toHaveBeenCalledTimes(2);
    await resource.load();
    expect(resource.snapshot().data).toBe(3);
  });

  it("discards a read that raced a mutation and coalesces invalidations", async () => {
    let release: (value: string) => void = () => undefined;
    const load = vi.fn(async () =>
      load.mock.calls.length === 1
        ? new Promise<string>((resolve) => {
            release = resolve;
          })
        : "fresh",
    );
    const resource = new SettingsResource(load);
    const snapshots: (string | null)[] = [];
    resource.subscribe(() => snapshots.push(resource.snapshot().data));
    const pending = resource.load();
    resource.invalidate();
    resource.invalidate();
    release("stale");
    await pending;
    expect(load).toHaveBeenCalledTimes(2);
    expect(snapshots).not.toContain("stale");
    expect(resource.snapshot()).toEqual({ data: "fresh", loading: false, error: "" });
  });

  it("leaves failed loads retryable and retains an existing snapshot on a refresh error", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Alo unavailable"))
      .mockResolvedValueOnce("saved")
      .mockRejectedValueOnce(new Error("Busy"));
    const resource = new SettingsResource(load);
    await resource.load();
    expect(resource.snapshot()).toEqual({ data: null, loading: false, error: "Alo unavailable" });
    await resource.reload();
    expect(resource.snapshot().data).toBe("saved");
    await resource.reload();
    expect(resource.snapshot()).toEqual({ data: "saved", loading: false, error: "Busy" });
  });
});
