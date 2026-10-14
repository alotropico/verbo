import { StringDecoder } from "node:string_decoder";
import { WEB_FRAME_LIMIT } from "./web-contracts";

export function encodeBrowserFrame(value: unknown): string {
  const frame = JSON.stringify(value);
  if (Buffer.byteLength(frame) > WEB_FRAME_LIMIT)
    throw new Error("protocol_limit");
  return `${frame}\n`;
}
export function browserFrameDecoder(
  accept: (value: unknown) => void,
): (chunk: Buffer) => void {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return (chunk) => {
    pending += decoder.write(chunk);
    for (;;) {
      const boundary = pending.indexOf("\n");
      if (boundary < 0) break;
      const line = pending.slice(0, boundary);
      if (Buffer.byteLength(line) > WEB_FRAME_LIMIT)
        throw new Error("protocol_limit");
      pending = pending.slice(boundary + 1);
      accept(JSON.parse(line));
    }
    if (Buffer.byteLength(pending) > WEB_FRAME_LIMIT)
      throw new Error("protocol_limit");
  };
}
