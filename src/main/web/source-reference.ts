import { createHash } from "node:crypto";
import { publicUrl } from "../../shared/public-network";

export function webSourceId(value: string): string {
  const url = publicUrl(value);
  url.hash = "";
  return `web:${createHash("sha256").update(url.href).digest("hex")}`;
}
