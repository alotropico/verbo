import { z } from "zod";

export const backendNoticeSchema = z
  .object({
    id: z.string().min(1).max(160),
    origin: z.literal("backend"),
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().min(1).max(500),
    code: z.string().min(1).max(64),
    commandId: z.string().max(128).optional(),
  })
  .strict();
export type BackendNotice = z.infer<typeof backendNoticeSchema>;
