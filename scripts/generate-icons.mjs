import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mark = JSON.parse(
  await readFile(join(root, "src/renderer/src/assets/verbo-mark.json"), "utf8"),
);
const theme = await readFile(
  join(root, "src/renderer/src/assets/globals.css"),
  "utf8",
);
const darkTheme = theme.slice(theme.indexOf(".dark,"));
const colors = {};

// Export the existing OKLCH theme colors as sRGB for native icon formats.
for (const token of ["primary", "card"]) {
  const match = darkTheme.match(
    new RegExp(`--${token}:\\s*oklch\\(([^)]+)\\)`),
  );
  if (!match) throw new Error(`Missing dark theme token: --${token}`);
  const [lightness, chroma, hue] = match[1].trim().split(/\s+/).map(Number);
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  colors[token] = `#${rgb
    .map((channel) => {
      const bounded = Math.max(0, Math.min(1, channel));
      const srgb =
        bounded <= 0.0031308
          ? 12.92 * bounded
          : 1.055 * bounded ** (1 / 2.4) - 0.055;
      return Math.round(srgb * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="${mark.viewBox}" fill="none">
  <rect x="1" y="1" width="30" height="30" rx="7" fill="${colors.card}"/>
  <path d="${mark.path}" transform="translate(2 2) scale(.875)" stroke="${colors.primary}" stroke-width="${mark.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
const buildDir = join(root, "build");
await mkdir(buildDir, { recursive: true });
await writeFile(join(buildDir, "icon.svg"), svg);
await writeFile(join(root, "src/renderer/src/assets/verbo-icon.svg"), svg);

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const builderDir = dirname(builderRequire.resolve("app-builder-lib"));
const { runIconsTool } = builderRequire(join(builderDir, "toolsets/icons.js"));
for (const format of ["ico", "icns", "set"]) {
  const outDir = format === "set" ? join(buildDir, "icons") : buildDir;
  await mkdir(outDir, { recursive: true });
  await runIconsTool({
    inputFile: join(buildDir, "icon.svg"),
    outputFormat: format,
    outDir,
  });
}

// Reuse the lossless 1024px PNG already generated inside the ICNS container.
const icns = await readFile(join(buildDir, "icon.icns"));
let png;
for (let offset = 8; offset < icns.length;) {
  const type = icns.toString("ascii", offset, offset + 4);
  const length = icns.readUInt32BE(offset + 4);
  if (length < 8 || offset + length > icns.length)
    throw new Error("Invalid ICNS chunk");
  if (type === "ic10") png = icns.subarray(offset + 8, offset + length);
  offset += length;
}
if (!png || png.readUInt32BE(16) !== 1024 || png.readUInt32BE(20) !== 1024) {
  throw new Error("The icon tool did not produce a 1024px PNG");
}
await writeFile(join(buildDir, "icon.png"), png);
console.log(
  "Generated Verbo SVG, PNG, ICO, ICNS, and Linux icons from the shared mark and theme tokens.",
);
