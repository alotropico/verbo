import { describe, expect, it } from "vitest";
import { chatPlaceholderTitle, sanitizeGeneratedTitle } from "./thread-title";

describe("chatPlaceholderTitle", () => {
  it("builds five stable non-alphanumeric marks from the id", () => {
    const title = chatPlaceholderTitle("thread-1");
    expect(title).toHaveLength(5);
    expect(title).toMatch(/^[^0-9A-Za-z]{5}$/);
    expect(chatPlaceholderTitle("thread-1")).toBe(title);
    expect(chatPlaceholderTitle("thread-2")).not.toBe(title);
  });

  it("ignores the local-id prefix", () => {
    expect(chatPlaceholderTitle("__LOCALID_Ab3xY9Z")).toBe(
      chatPlaceholderTitle("Ab3xY9Z"),
    );
  });
});

describe("sanitizeGeneratedTitle", () => {
  it("returns the first non-empty line without quotes", () => {
    expect(sanitizeGeneratedTitle('"Garden plan"\nextra')).toBe("Garden plan");
  });

  it("strips think blocks and title labels", () => {
    expect(
      sanitizeGeneratedTitle("<think>hm</think>\nTitle: Weekend trip"),
    ).toBe("Weekend trip");
  });

  it("returns undefined for blank output", () => {
    expect(sanitizeGeneratedTitle("   \n  ")).toBeUndefined();
  });
});
