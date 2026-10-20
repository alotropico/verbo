import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

const feedback = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("./notify", () => feedback);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("native clipboard copy", () => {
  it("waits for the native acknowledgement, even when the browser clipboard is denied", async () => {
    let finish!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const browserWrite = vi
      .fn()
      .mockRejectedValue(new Error("NotAllowedError"));
    vi.stubGlobal("window", { verbo: { clipboard: { writeText } } });
    vi.stubGlobal("navigator", { clipboard: { writeText: browserWrite } });
    let completed = false;
    const copied = copyText("Full message\n第二行").then((value) => {
      completed = value;
      return value;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(writeText).toHaveBeenCalledWith("Full message\n第二行");
    expect(browserWrite).not.toHaveBeenCalled();
    finish();
    expect(await copied).toBe(true);
    expect(feedback.notify).not.toHaveBeenCalled();
  });

  it("shows a recoverable error and does not report a failed write as copied", async () => {
    const writeText = vi
      .fn()
      .mockRejectedValue(new Error("Clipboard unavailable"));
    vi.stubGlobal("window", { verbo: { clipboard: { writeText } } });
    expect(await copyText("A whole chat")).toBe(false);
    expect(feedback.notify).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "error" }),
    );
  });
});
