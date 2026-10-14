import { z } from "zod";
import { persistedThreadIdSchema } from "./thread-identity";

/**
 * Caps chosen so a page fits the 4000-character action detail and a walk
 * cannot scan a whole disk. Callers may request a larger pageSize; the
 * envelope returns fewer rows and the cursor continues at the last row sent.
 */
export const FILE_QUERY_LIMITS = {
  maxPageSize: 100,
  defaultPageSize: 20,
  maxVisited: 4000,
  maxTimeMs: 1500,
  maxSnapshots: 24,
  maxSnapshotItems: 20000,
  snapshotTtlMs: 15 * 60 * 1000,
  maxContentBytes: 256 * 1024,
  maxSnippetsPerFile: 5,
  maxSnippetChars: 400,
  defaultSnippetChars: 180,
  detailBudget: 3800,
  maxWarnings: 8,
} as const;

export const TEXT_EXTENSIONS = [
  "md",
  "markdown",
  "txt",
  "json",
  "yaml",
  "yml",
  "csv",
  "tsv",
] as const;

export const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
] as const;

const sortSchema = z
  .object({
    by: z
      .enum(["name", "extension", "type", "size", "modified", "created"])
      .default("name"),
    direction: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();

const queryFields = {
  root: z.string().trim().min(1).max(1024),
  path: z.string().trim().min(1).max(1024).optional(),
  entryType: z.enum(["all", "files", "directories"]).default("all"),
  name: z.string().trim().min(1).max(256).optional(),
  glob: z.string().trim().min(1).max(256).optional(),
  extensions: z.array(z.string().trim().min(1).max(32)).max(32).optional(),
  minSize: z.number().int().nonnegative().optional(),
  maxSize: z.number().int().nonnegative().optional(),
  modifiedAfter: z.string().datetime().optional(),
  modifiedBefore: z.string().datetime().optional(),
  sort: sortSchema.optional(),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(FILE_QUERY_LIMITS.maxPageSize)
    .default(FILE_QUERY_LIMITS.defaultPageSize),
  cursor: z.string().trim().min(16).max(80).optional(),
  includeHidden: z.boolean().default(false),
};

export const filesListArgsSchema = z.object(queryFields).strict();

export const filesSearchArgsSchema = z
  .object({
    ...queryFields,
    mode: z.enum(["filename", "content"]),
    query: z.string().trim().min(1).max(200).optional(),
    caseSensitive: z.boolean().default(false),
    groupBy: z.enum(["file", "match"]).default("file"),
    snippetChars: z
      .number()
      .int()
      .min(40)
      .max(FILE_QUERY_LIMITS.maxSnippetChars)
      .default(FILE_QUERY_LIMITS.defaultSnippetChars),
  })
  .strict();

export const filesStatArgsSchema = z
  .object({
    paths: z.array(z.string().trim().min(1).max(1024)).min(1).max(32),
  })
  .strict();

export const filesSummaryArgsSchema = z
  .object({
    root: z.string().trim().min(1).max(1024),
    path: z.string().trim().min(1).max(1024).optional(),
    entryType: z.enum(["all", "files", "directories"]).default("all"),
    includeHidden: z.boolean().default(false),
  })
  .strict();

export const filesNextArgsSchema = z
  .object({
    cursor: z.string().trim().min(16).max(80),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(FILE_QUERY_LIMITS.maxPageSize)
      .default(FILE_QUERY_LIMITS.defaultPageSize),
  })
  .strict();

export type FilesListArgs = z.infer<typeof filesListArgsSchema>;
export type FilesSearchArgs = z.infer<typeof filesSearchArgsSchema>;
export type FilesStatArgs = z.infer<typeof filesStatArgsSchema>;
export type FilesSummaryArgs = z.infer<typeof filesSummaryArgsSchema>;
export type FileQuerySort = z.infer<typeof sortSchema>;

export const FILE_UI_ACTIONS = [
  "files.list",
  "files.next",
  "files.search",
  "files.stat",
  "files.summary",
  "files.read",
  "files.compare",
  "files.hash",
  "files.inspect_image",
] as const;

export type FileUiAction = (typeof FILE_UI_ACTIONS)[number];

export const fileUiQuerySchema = z
  .object({
    threadId: persistedThreadIdSchema,
    actionId: z.enum(FILE_UI_ACTIONS),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
