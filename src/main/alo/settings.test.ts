import { describe, expect, it, vi } from "vitest";
import { aloCall } from "./client";
import { readCommandSettings } from "./settings";

vi.mock("./client", () => ({ aloCall: vi.fn() }));

describe("Commands settings transport", () => {
  it("reads the complete UI snapshot with one async call and no catalog subprocesses", async () => {
    const snapshot = {
      metadata: [],
      nodes: [{ id: "files", aliases: [], description: "Files" }],
      defaults: [],
      entries: [{ id: "files", kind: "category" }],
    };
    vi.mocked(aloCall).mockResolvedValue(snapshot);
    expect(await readCommandSettings()).toEqual(snapshot);
    expect(aloCall).toHaveBeenCalledExactlyOnceWith({
      method: "settings.read",
      args: {},
      context: { actor: "ui", threadId: "alo-settings" },
    });
  });
});
