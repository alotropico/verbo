import { afterEach, describe, it, expect, vi } from "vitest";
import { AutosaveController, LONG_TEXT_SAVE_DELAY } from "./autosave";

afterEach(() => vi.useRealTimers());

describe("serialized settings autosave", () => {
  it("waits one second after the latest change and uses 1.5 seconds for long text", async () => {
    vi.useFakeTimers();
    const save = vi.fn<(value: string) => Promise<void>>(async () => undefined);
    const queue = new AutosaveController(save, () => undefined);
    queue.schedule("first");
    await vi.advanceTimersByTimeAsync(800);
    queue.schedule("latest");
    await vi.advanceTimersByTimeAsync(999);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledExactlyOnceWith("latest");
    queue.schedule("long text", LONG_TEXT_SAVE_DELAY);
    await vi.advanceTimersByTimeAsync(1499);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenLastCalledWith("long text");
  });

  it("flushes on blur immediately and does not duplicate the timer write", async () => {
    vi.useFakeTimers();
    const save = vi.fn<(value: string) => Promise<void>>(async () => undefined);
    const queue = new AutosaveController(save, () => undefined);
    queue.schedule("blur", LONG_TEXT_SAVE_DELAY);
    await Promise.all([queue.flush(), queue.flush()]);
    expect(save).toHaveBeenCalledExactlyOnceWith("blur");
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not let an older write bypass a newer edit's debounce", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => undefined;
    const save = vi.fn<(value: string) => Promise<void>>(async () => {
      if (save.mock.calls.length === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
    });
    const queue = new AutosaveController(save, () => undefined);
    queue.schedule("first");
    const blur = queue.flush();
    await vi.advanceTimersByTimeAsync(100);
    queue.schedule("second");
    finish();
    await blur;
    await vi.advanceTimersByTimeAsync(999);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenLastCalledWith("second");
  });

  it("ignores unchanged values and cancels a pending edit reverted to its baseline", async () => {
    vi.useFakeTimers();
    const save = vi.fn<(value: { enabled?: boolean; text?: string }) => Promise<void>>(async () => undefined);
    const queue = new AutosaveController(
      save,
      () => undefined,
      1000,
      (previous, next) => ({ ...previous, ...next }),
    );
    queue.baseline({ enabled: false, text: "saved" });
    queue.schedule({ enabled: false });
    queue.schedule({ text: "saved" });
    queue.schedule({ text: "saved", enabled: false });
    queue.schedule({ enabled: true });
    queue.schedule({ enabled: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).not.toHaveBeenCalled();
    queue.schedule({ enabled: true });
    await queue.flush();
    queue.schedule({ enabled: true });
    await queue.flush();
    expect(save).toHaveBeenCalledTimes(1);
    queue.acceptBaseline({ enabled: false, text: "external change" });
    queue.schedule({ enabled: true });
    await queue.flush();
    expect(save).toHaveBeenCalledTimes(2);
  });
  it("replays failed in-flight partial fields with the newer draft", async () => {
    const written: object[] = [];
    let rejectFirst: ((error: Error) => void) | undefined;
    const queue = new AutosaveController<{
      model?: string;
      temperature?: number;
    }>(
      async (value) => {
        written.push(value);
        if (written.length === 1)
          await new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          });
      },
      () => undefined,
      10000,
      (previous, next) => ({ ...previous, ...next }),
    );
    queue.schedule({ model: "keep" });
    const saving = queue.flush();
    queue.schedule({ temperature: 0.8 });
    rejectFirst?.(new Error("temporary failure"));
    await saving;
    expect(written).toEqual([{ model: "keep" }]);
    await queue.flush();
    expect(written).toEqual([{ model: "keep" }, { model: "keep", temperature: 0.8 }]);
  });
  it("coalesces pending patches and saves a newer edit after an in-flight write", async () => {
    const written: object[] = [];
    let release: (() => void) | undefined;
    const queue = new AutosaveController<{
      model?: string;
      temperature?: number;
    }>(
      async (value) => {
        written.push(value);
        if (written.length === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
      },
      () => undefined,
      10000,
      (previous, next) => ({ ...previous, ...next }),
    );
    queue.schedule({ model: "one" });
    queue.schedule({ temperature: 0.4 });
    const first = queue.flush();
    queue.schedule({ model: "two" });
    queue.schedule({ temperature: 0.8 });
    release?.();
    await first;
    expect(written).toEqual([{ model: "one", temperature: 0.4 }]);
    await queue.flush();
    expect(written).toEqual([
      { model: "one", temperature: 0.4 },
      { model: "two", temperature: 0.8 },
    ]);
  });
  it("retains a failed draft for retry and resets pending edits before restoring defaults", async () => {
    let fail = true;
    const written: string[] = [];
    const states: string[] = [];
    const queue = new AutosaveController<string>(
      async (value) => {
        if (fail) throw new Error("offline");
        written.push(value);
      },
      (state) => states.push(state.status),
      10000,
    );
    queue.schedule("draft");
    await queue.flush();
    expect(states.at(-1)).toBe("error");
    fail = false;
    queue.retry();
    await queue.flush();
    expect(written).toEqual(["draft"]);
    queue.schedule("obsolete");
    await queue.reset();
    await queue.flush();
    expect(written).toEqual(["draft"]);
  });
  it("keeps failed partial fields when a subsequent field is edited", async () => {
    let fail = true;
    const written: object[] = [];
    const queue = new AutosaveController<{
      model?: string;
      temperature?: number;
    }>(
      async (value) => {
        if (fail) throw new Error("offline");
        written.push(value);
      },
      () => undefined,
      10000,
      (previous, next) => ({ ...previous, ...next }),
    );
    queue.schedule({ model: "retain" });
    await queue.flush();
    fail = false;
    queue.schedule({ temperature: 0.7 });
    await queue.flush();
    expect(written).toEqual([{ model: "retain", temperature: 0.7 }]);
  });
});
