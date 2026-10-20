import { createHash } from "node:crypto";

export function stableCommandJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}
export function commandFingerprint(value: unknown): string {
  return createHash("sha256").update(stableCommandJson(value)).digest("hex");
}
