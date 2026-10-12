import { z } from "zod";

export const fileSurfaceIntents = ["open", "reveal", "copy"] as const;

export type FileSurfaceIntent = (typeof fileSurfaceIntents)[number];

export const fileSurfaceSchema = z
  .object({
    path: z.string().trim().min(1).max(1024),
    intent: z.enum(fileSurfaceIntents),
  })
  .strict();

export type FileSurfaceResult =
  { ok: true } | { ok: false; code: string; summary: string };
