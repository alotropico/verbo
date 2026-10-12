import { describe, expect, it } from "vitest";
import { revealTextPrefix, speechProgress } from "./speech-reveal";

describe("speech reveal", () => {
  it("keeps a word hidden until playback reaches its start", () => {
    const text = "one two three";
    expect(revealTextPrefix(text, 0)).toBe("");
    expect(revealTextPrefix(text, Number.NaN)).toBe("");
    expect(revealTextPrefix(text, 0.01)).toBe("one");
    expect(revealTextPrefix(text, 4 / text.length - 0.001)).toBe("one");
    expect(revealTextPrefix(text, 4 / text.length)).toBe("one two");
    expect(revealTextPrefix(text, 1)).toBe(text);
  });

  it("shows the first word when speech starts after leading space", () => {
    const text = "  hi there";
    expect(revealTextPrefix(text, 0.01)).toBe("  hi");
    expect(revealTextPrefix(text, 5 / text.length)).toBe(text);
  });

  it("weights later chunks by how long they are", () => {
    const chunks = ["aa", "bbbb"];
    expect(speechProgress({ chunks, index: 0, chunkRatio: 0.5 })).toBeCloseTo(
      1 / 6,
    );
    expect(speechProgress({ chunks, index: 1, chunkRatio: 0 })).toBeCloseTo(
      2 / 6,
    );
    expect(speechProgress({ chunks, index: 1, chunkRatio: 1 })).toBe(1);
    expect(speechProgress({ chunks: [], index: 0, chunkRatio: 0 })).toBe(1);
  });
});
