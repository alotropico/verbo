export type ImageMeta = {
  format: "png" | "jpeg" | "gif" | "bmp" | "webp";
  width: number;
  height: number;
};

function png(buffer: Buffer): ImageMeta | null {
  if (buffer.length < 24) return null;
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  if (buffer.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { format: "png", width, height };
}

function jpeg(buffer: Buffer): ImageMeta | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8)
    return null;
  let cursor = 2;
  const limit = Math.min(buffer.length, 1024 * 1024);
  while (cursor + 8 < limit) {
    if (buffer[cursor] !== 0xff) return null;
    const marker = buffer[cursor + 1] ?? 0;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) {
      cursor += 2;
      continue;
    }
    if (marker === 0xda) return null;
    const length = buffer.readUInt16BE(cursor + 2);
    if (length < 2) return null;
    if (
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3
    ) {
      const height = buffer.readUInt16BE(cursor + 5);
      const width = buffer.readUInt16BE(cursor + 7);
      if (width === 0 || height === 0) return null;
      return { format: "jpeg", width, height };
    }
    cursor += 2 + length;
  }
  return null;
}

function gif(buffer: Buffer): ImageMeta | null {
  if (buffer.length < 10) return null;
  const head = buffer.subarray(0, 6).toString("latin1");
  if (head !== "GIF87a" && head !== "GIF89a") return null;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  if (width === 0 || height === 0) return null;
  return { format: "gif", width, height };
}

function bmp(buffer: Buffer): ImageMeta | null {
  if (buffer.length < 26 || buffer.subarray(0, 2).toString("latin1") !== "BM") {
    return null;
  }
  const width = buffer.readInt32LE(18);
  const height = Math.abs(buffer.readInt32LE(22));
  if (width <= 0 || height <= 0) return null;
  return { format: "bmp", width, height };
}

function webp(buffer: Buffer): ImageMeta | null {
  if (buffer.length < 30) return null;
  if (buffer.subarray(0, 4).toString("latin1") !== "RIFF") return null;
  if (buffer.subarray(8, 12).toString("latin1") !== "WEBP") return null;
  const chunk = buffer.subarray(12, 16).toString("latin1");
  if (chunk === "VP8X") {
    const width = 1 + (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16));
    const height = 1 + (buffer[27]! | (buffer[28]! << 8) | (buffer[29]! << 16));
    if (width <= 0 || height <= 0) return null;
    return { format: "webp", width, height };
  }
  if (chunk === "VP8L" && buffer[20] === 0x2f) {
    const first = buffer[21] ?? 0;
    const second = buffer[22] ?? 0;
    const third = buffer[23] ?? 0;
    const fourth = buffer[24] ?? 0;
    const width = 1 + (((second & 0x3f) << 8) | first);
    const height =
      1 + (((fourth & 0x0f) << 10) | (third << 2) | ((second & 0xc0) >> 6));
    if (width <= 0 || height <= 0) return null;
    return { format: "webp", width, height };
  }
  return null;
}

export function readImageMeta(buffer: Buffer): ImageMeta | null {
  return (
    png(buffer) ?? jpeg(buffer) ?? gif(buffer) ?? bmp(buffer) ?? webp(buffer)
  );
}
