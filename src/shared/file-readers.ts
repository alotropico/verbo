import { z } from "zod";

/** Bounds for one explicit read. A page of text must fit the action detail. */
export const FILE_READER_LIMITS = {
  maxReadBytes: 256 * 1024,
  maxReturnedChars: 3500,
  defaultLineCount: 80,
  maxLineCount: 400,
  maxCompareLines: 200,
  maxHashBytes: 8 * 1024 * 1024,
  maxHashCount: 8,
  maxImageCount: 4,
  maxImageScanBytes: 1024 * 1024,
  maxPayloadBytes: 1500,
  maxPdfPages: 5,
} as const;

export const filesReadArgsSchema = z
  .object({
    path: z.string().trim().min(1).max(1024),
    mode: z.enum(["auto", "text", "json", "pdf"]).default("auto"),
    startLine: z.number().int().min(1).max(1_000_000).default(1),
    lineCount: z
      .number()
      .int()
      .min(1)
      .max(FILE_READER_LIMITS.maxLineCount)
      .default(FILE_READER_LIMITS.defaultLineCount),
    pointer: z.string().max(512).optional(),
    page: z.number().int().min(1).max(10_000).default(1),
    pageCount: z
      .number()
      .int()
      .min(1)
      .max(FILE_READER_LIMITS.maxPdfPages)
      .default(1),
  })
  .strict();

export const filesCompareArgsSchema = z
  .object({
    left: z.string().trim().min(1).max(1024),
    right: z.string().trim().min(1).max(1024).optional(),
    proposed: z.string().max(FILE_READER_LIMITS.maxReturnedChars).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasRight = value.right !== undefined;
    const hasProposed = value.proposed !== undefined;
    if (hasRight === hasProposed) {
      context.addIssue({
        code: "custom",
        message: "Compare one file with a second path or with proposed text.",
      });
    }
  });

export const filesHashArgsSchema = z
  .object({
    paths: z
      .array(z.string().trim().min(1).max(1024))
      .min(1)
      .max(FILE_READER_LIMITS.maxHashCount),
    algorithm: z.literal("sha256").default("sha256"),
  })
  .strict();

export const filesInspectImageArgsSchema = z
  .object({
    paths: z
      .array(z.string().trim().min(1).max(1024))
      .min(1)
      .max(FILE_READER_LIMITS.maxImageCount),
    includePayload: z.boolean().default(false),
  })
  .strict();

export type FilesReadArgs = z.infer<typeof filesReadArgsSchema>;
export type FilesCompareArgs = z.infer<typeof filesCompareArgsSchema>;
export type FilesHashArgs = z.infer<typeof filesHashArgsSchema>;
export type FilesInspectImageArgs = z.infer<typeof filesInspectImageArgsSchema>;
