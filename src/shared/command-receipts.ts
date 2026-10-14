import { z } from "zod";
import type { ActionResult } from "./action-contract";

export const commandResourceSchema = z
  .object({
    path: z.string().min(1).max(1024),
    event: z.enum(["read", "write", "copy", "move", "remove"]),
    from: z.string().max(1024).optional(),
    available: z.boolean(),
    unavailableReason: z.string().max(300).optional(),
    size: z.number().nonnegative().optional(),
    mtimeMs: z.number().optional(),
  })
  .strict();
export type CommandResource = z.infer<typeof commandResourceSchema>;
export const commandReceiptRequestSchema = z
  .object({
    receiptId: z.string().min(1).max(128),
    threadId: z.string().min(1).max(128),
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict();
export type CommandReceipt = {
  id: string;
  action: string;
  result: ActionResult;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  resources: CommandResource[];
  totalResources: number;
  more: boolean;
  children: unknown[];
};
