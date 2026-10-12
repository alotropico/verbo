import { describe, expect, it } from "vitest";
import { timestampMs } from "./thread-activity";

describe("timestampMs", () => {
  it("reads a Date, an ISO string, and a number", () => {
    const at = Date.parse("2026-10-12T13:00:00.000Z");
    expect(timestampMs(new Date(at))).toBe(at);
    expect(timestampMs("2026-10-12T13:00:00.000Z")).toBe(at);
    expect(timestampMs(at)).toBe(at);
  });

  it("returns 0 for a missing or unusable value", () => {
    expect(timestampMs(undefined)).toBe(0);
    expect(timestampMs(null)).toBe(0);
    expect(timestampMs("not a date")).toBe(0);
    expect(timestampMs({})).toBe(0);
  });
});
