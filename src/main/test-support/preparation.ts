import { createHash } from "node:crypto";
import { z } from "zod";
import type { ActionResult } from "../../shared/action-contract";
import type { ActionContext, CapabilityRegistry } from "./registry";

export const preparedEffectSchema = z
  .object({
    action: z.string().min(1).max(160),
    args: z.record(z.string(), z.json()),
    signature: z.string().length(64),
    snapshot: z.json(),
    summary: z.string().min(1).max(500),
    automatic: z.boolean(),
    readOnly: z.literal(true).optional(),
    risks: z.array(z.string().max(500)).max(8).default([]),
    details: z.string().max(32768).optional(),
  })
  .strict();
export type PreparedEffect = z.infer<typeof preparedEffectSchema>;
export type EffectPreparation = Pick<
  PreparedEffect,
  "snapshot" | "summary" | "automatic"
> & { risks?: string[]; details?: string; readOnly?: true };
export type PreparationRequest = {
  action: string;
  signature: string;
  effects: PreparedEffect[];
  reads: ActionResult[];
  aggregate?: string;
  context: ActionContext;
};
export type PreparationOwner = {
  submit: (
    request: PreparationRequest,
    registry: CapabilityRegistry,
  ) => Promise<ActionResult>;
  consume: (
    effect: PreparedEffect,
    context: ActionContext,
  ) => "missing" | "invalid" | { index: number };
};

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
