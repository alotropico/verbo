import { describe, expect, it } from "vitest";
import {
  clearModelVision,
  modelSupportsVision,
  refreshModelVision,
} from "./model-vision";

describe("model vision", () => {
  it("remembers a vision capability and fails closed otherwise", async () => {
    clearModelVision();
    const fetchImpl = (async () =>
      ({
        ok: true,
        json: async () => ({ capabilities: ["completion", "vision"] }),
      }) as Response) as typeof fetch;
    await expect(refreshModelVision("qwen", fetchImpl)).resolves.toBe(true);
    expect(modelSupportsVision("qwen")).toBe(true);
    const missing = (async () =>
      ({
        ok: false,
        json: async () => ({}),
      }) as Response) as typeof fetch;
    await expect(refreshModelVision("text-only", missing)).resolves.toBe(false);
    expect(modelSupportsVision("text-only")).toBe(false);
    clearModelVision();
  });
});
