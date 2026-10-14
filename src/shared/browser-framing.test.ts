import { describe, expect, it } from "vitest";
import { browserFrameDecoder, encodeBrowserFrame } from "./browser-framing";
import { WEB_FRAME_LIMIT } from "./web-contracts";

describe("bounded browser frames", () => {
  it("decodes multiple and fragmented Unicode messages in order", () => {
    const received: unknown[] = [];
    const decode = browserFrameDecoder((value) => received.push(value));
    const frames = Buffer.from(
      encodeBrowserFrame({ text: "ação 🌍" }) +
        encodeBrowserFrame({ next: true }),
    );
    for (const byte of frames) decode(Buffer.from([byte]));
    expect(received).toEqual([{ text: "ação 🌍" }, { next: true }]);
  });
  it("rejects oversized, malformed and unterminated oversized frames", () => {
    expect(() =>
      encodeBrowserFrame({ text: "x".repeat(WEB_FRAME_LIMIT) }),
    ).toThrow("protocol_limit");
    expect(() =>
      browserFrameDecoder(() => {})(Buffer.from("bad-json\n")),
    ).toThrow();
    expect(() =>
      browserFrameDecoder(() => {})(
        Buffer.from("x".repeat(WEB_FRAME_LIMIT + 1)),
      ),
    ).toThrow("protocol_limit");
  });
});
