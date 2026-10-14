import { describe, it, expect } from "vitest";
import { AutosaveController } from "./autosave";

describe("serialized settings autosave", () => {
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
    expect(written).toEqual([
      { model: "keep" },
      { model: "keep", temperature: 0.8 },
    ]);
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
