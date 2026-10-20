import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { verifyAloBundle } from "./alo-bundle.mjs";

export default function beforePack() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  verifyAloBundle({
    bundle: join(root, "resources/alo"),
    owner: resolve(root, "../alo"),
  });
}
