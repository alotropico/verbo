import { describe, expect, it } from "vitest";
import {
  rangeChatSelection,
  toggleChatSelection,
  visibleChatSelection,
} from "./chat-selection";

describe("chat selection", () => {
  it("toggles extras and leaves the anchor in place", () => {
    expect(toggleChatSelection("a", [], "b")).toEqual(["b"]);
    expect(toggleChatSelection("a", ["b"], "c")).toEqual(["b", "c"]);
    expect(toggleChatSelection("a", ["b", "c"], "b")).toEqual(["c"]);
    expect(toggleChatSelection("a", ["b"], "a")).toEqual(["b"]);
  });

  it("selects the inclusive range around the anchor", () => {
    const order = ["a", "b", "c", "d"];
    expect(rangeChatSelection("a", order, "c")).toEqual(["b", "c"]);
    expect(rangeChatSelection("c", order, "a")).toEqual(["a", "b"]);
    expect(rangeChatSelection("a", order, "a")).toEqual([]);
    expect(rangeChatSelection("z", order, "b")).toEqual(["a", "b"]);
  });

  it("selects every visible chat except the anchor", () => {
    expect(visibleChatSelection("b", ["a", "b", "c"])).toEqual(["a", "c"]);
  });
});
