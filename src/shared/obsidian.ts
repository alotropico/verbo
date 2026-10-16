import { z } from "zod";

export const OBSIDIAN_ADAPTER_VERSION = 1;
export const obsidianOperations = [
  "read",
  "create",
  "edit",
  "move",
  "rename",
  "delete",
] as const;
export type ObsidianOperation = (typeof obsidianOperations)[number];
export const notePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine(
    (path) =>
      !/^[\\/]|^[a-z]:/iu.test(path) &&
      !path.includes("\0") &&
      path
        .split(/[\\/]/u)
        .every(
          (part) =>
            part && part !== "." && part !== ".." && !part.includes(":"),
        ),
    "Use an exact relative note path within the selected vault.",
  );
export const obsidianTargetSchema = z
  .object({ vault: z.string().trim().min(1).max(128), path: notePathSchema })
  .strict();
export const obsidianCreateSchema = obsidianTargetSchema
  .extend({
    content: z.string().max(24000).optional(),
    contentRef: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.content === undefined) !== (value.contentRef === undefined),
    "Supply content or contentRef.",
  );
export const obsidianEditSchema = obsidianCreateSchema
  .safeExtend({ revision: z.string().length(64) })
  .strict();
export const obsidianTransferSchema = obsidianTargetSchema
  .extend({ to: notePathSchema, revision: z.string().length(64).optional() })
  .strict();
export const obsidianDeleteSchema = obsidianTargetSchema
  .extend({ revision: z.string().length(64).optional() })
  .strict();
export const obsidianHelpSchema = z
  .object({
    vault: z.string().min(1).max(128),
    command: z
      .string()
      .regex(/^[a-z][a-z0-9:-]{0,79}$/iu)
      .optional(),
  })
  .strict();
export const obsidianCliSchema = z
  .object({
    vault: z.string().min(1).max(128),
    command: z.string().regex(/^[a-z][a-z0-9:-]{0,79}$/iu),
    args: z.array(z.string().max(24000)).max(24).default([]),
  })
  .strict();

export const obsidianQualificationSchema = z
  .object({
    adapterVersion: z.literal(1),
    executableIdentity: z.string(),
    applicationIdentity: z.string(),
    appVersion: z.string().max(100),
    qualifiedAt: z.number(),
    enabled: z.boolean(),
    evidence: z.string().max(2000),
    operations: z.record(
      z.enum(obsidianOperations),
      z
        .object({ supported: z.boolean(), reason: z.string().max(2000) })
        .strict(),
    ),
    passthrough: z.boolean(),
  })
  .strict();
export type ObsidianQualification = z.infer<typeof obsidianQualificationSchema>;

export const OBSIDIAN_DOCUMENTATION_URL = "https://obsidian.md/help/cli";
