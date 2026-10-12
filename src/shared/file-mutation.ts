import { z } from "zod";

export const FILE_MUTATION_LIMITS = {
  maxItems: 100,
  maxContentChars: 256 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxTreeEntries: 4000,
  planTtlMs: 15 * 60 * 1000,
  maxPlans: 32,
  maxAuditRows: 400,
  detailBudget: 3800,
  largeFolderEntries: 50,
} as const;

const fileRef = z.string().trim().min(1).max(1024);
const fileFormatSchema = z.enum(["text", "json", "markdown"]);

const createItemSchema = z
  .object({
    path: fileRef,
    kind: z.enum(["file", "directory"]),
    content: z.string().max(FILE_MUTATION_LIMITS.maxContentChars).optional(),
    format: fileFormatSchema.optional(),
  })
  .strict();

const transferPairSchema = z
  .object({
    from: fileRef,
    to: fileRef,
  })
  .strict();

export const filesCreateArgsSchema = z
  .object({
    path: fileRef.optional(),
    kind: z.enum(["file", "directory"]).optional(),
    content: z.string().max(FILE_MUTATION_LIMITS.maxContentChars).optional(),
    format: fileFormatSchema.optional(),
    items: z
      .array(createItemSchema)
      .min(1)
      .max(FILE_MUTATION_LIMITS.maxItems)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const single = value.path !== undefined || value.kind !== undefined;
    if (single === (value.items !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Provide one path and kind, or an items list.",
      });
    }
    if (single && (value.path === undefined || value.kind === undefined)) {
      context.addIssue({
        code: "custom",
        message: "A single create needs both path and kind.",
      });
    }
    if (value.kind === "directory" && value.content !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A directory create cannot include content.",
      });
    }
    for (const item of value.items ?? []) {
      if (item.kind === "directory" && item.content !== undefined) {
        context.addIssue({
          code: "custom",
          message: "A directory create cannot include content.",
        });
      }
    }
  });

export const filesEditArgsSchema = z
  .object({
    path: fileRef,
    mode: z.enum(["full", "replace", "lines"]),
    content: z.string().max(FILE_MUTATION_LIMITS.maxContentChars).optional(),
    find: z.string().min(1).max(4000).optional(),
    replace: z.string().max(FILE_MUTATION_LIMITS.maxContentChars).optional(),
    expectedMatches: z.number().int().positive().max(50).optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    format: fileFormatSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "full" && value.content === undefined) {
      context.addIssue({
        code: "custom",
        message: "A full edit needs content.",
      });
    }
    if (value.mode === "replace") {
      if (
        !value.find ||
        value.replace === undefined ||
        !value.expectedMatches
      ) {
        context.addIssue({
          code: "custom",
          message: "A replace edit needs find, replace, and expectedMatches.",
        });
      }
    }
    if (value.mode === "lines") {
      if (
        value.content === undefined ||
        value.startLine === undefined ||
        value.endLine === undefined ||
        value.endLine < (value.startLine ?? 0)
      ) {
        context.addIssue({
          code: "custom",
          message: "A line edit needs content, startLine, and endLine.",
        });
      }
    }
  });

export const filesTransferArgsSchema = z
  .object({
    from: fileRef.optional(),
    to: fileRef.optional(),
    items: z
      .array(transferPairSchema)
      .min(1)
      .max(FILE_MUTATION_LIMITS.maxItems)
      .optional(),
    resultSet: z.string().uuid().optional(),
    toDirectory: fileRef.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const pair = value.from !== undefined || value.to !== undefined;
    const modes =
      Number(pair) +
      Number(value.items !== undefined) +
      Number(value.resultSet !== undefined);
    if (modes !== 1) {
      context.addIssue({
        code: "custom",
        message: "Provide one from/to pair, an items list, or a resultSet.",
      });
      return;
    }
    if (pair && (value.from === undefined || value.to === undefined)) {
      context.addIssue({
        code: "custom",
        message: "A transfer needs both from and to.",
      });
    }
    if (value.resultSet && value.toDirectory === undefined) {
      context.addIssue({
        code: "custom",
        message: "A resultSet transfer needs toDirectory.",
      });
    }
    if (!value.resultSet && value.toDirectory !== undefined) {
      context.addIssue({
        code: "custom",
        message: "toDirectory is only valid with a resultSet.",
      });
    }
  });

export const filesTrashArgsSchema = z
  .object({
    path: fileRef.optional(),
    paths: z
      .array(fileRef)
      .min(1)
      .max(FILE_MUTATION_LIMITS.maxItems)
      .optional(),
    resultSet: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const modes = [
      value.path !== undefined,
      value.paths !== undefined,
      value.resultSet !== undefined,
    ].filter(Boolean).length;
    if (modes !== 1) {
      context.addIssue({
        code: "custom",
        message: "Provide one path, a paths list, or a resultSet.",
      });
    }
  });

const batchCreateSchema = createItemSchema
  .extend({ action: z.literal("files.create") })
  .strict();
const batchTransferSchema = transferPairSchema
  .extend({
    action: z.enum(["files.copy", "files.move", "files.rename"]),
  })
  .strict();
const batchTrashSchema = z
  .object({
    action: z.literal("files.trash"),
    path: fileRef,
  })
  .strict();

export const filesBatchArgsSchema = z
  .object({
    items: z
      .array(
        z.union([batchCreateSchema, batchTransferSchema, batchTrashSchema]),
      )
      .min(1)
      .max(FILE_MUTATION_LIMITS.maxItems),
  })
  .strict();

export const filesUndoArgsSchema = z
  .object({
    operationId: z.string().uuid(),
  })
  .strict();

export type FilesCreateArgs = z.infer<typeof filesCreateArgsSchema>;
export type FilesEditArgs = z.infer<typeof filesEditArgsSchema>;
export type FilesTransferArgs = z.infer<typeof filesTransferArgsSchema>;
export type FilesTrashArgs = z.infer<typeof filesTrashArgsSchema>;
export type FilesBatchArgs = z.infer<typeof filesBatchArgsSchema>;
export type FileFormat = z.infer<typeof fileFormatSchema>;

export type OperationReviewItem = {
  index: number;
  kind: string;
  from: string | null;
  to: string | null;
  status: string;
  diff?: string;
  error?: string;
};

export type OperationReview = {
  ok: true;
  operationId: string;
  threadId: string;
  action: string;
  status: string;
  summary: string;
  count: number;
  risks: string[];
  items: OperationReviewItem[];
  receipt: { succeeded: number; failed: number; notAttempted: number };
};

export function operationInventoryLine(review: OperationReview): string {
  const aliases = new Set<string>();
  for (const item of review.items) {
    for (const path of [item.from, item.to]) {
      const alias = path?.match(/^([A-Za-z][\w-]{1,31}):/u)?.[1];
      if (alias) aliases.add(alias);
    }
  }
  const count = `${review.count} item${review.count === 1 ? "" : "s"}`;
  const where = aliases.size > 0 ? ` in ${[...aliases].sort().join(", ")}` : "";
  return `${count}${where}`;
}

export type OperationReviewFailure = {
  ok: false;
  code: string;
  summary: string;
};
