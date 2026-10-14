import { z } from "zod";

export const searchEngineSchema = z.enum(["google", "duckduckgo", "bing"]);
export type SearchEngineId = z.infer<typeof searchEngineSchema>;
export const browserDiagnosticSchema = z
  .object({
    event: z.literal("browser_request"),
    op: z.enum(["searchEngine", "readRenderedPage"]),
    engine: searchEngineSchema.optional(),
    outcome: z.string().regex(/^[a-z_0-9]{1,64}$/),
    durationMs: z.number().int().min(0).max(120000),
  })
  .strict();
export const webSettingsSchema = z
  .object({
    engines: z
      .array(searchEngineSchema)
      .min(1)
      .max(3)
      .refine(
        (value) => new Set(value).size === value.length,
        "Each engine may appear once.",
      )
      .default(["google", "duckduckgo", "bing"]),
    executable: z.string().max(1024).default(""),
    headless: z.literal(true).default(true),
    idleMs: z.number().int().min(10000).max(300000).default(120000),
    engineTimeoutMs: z.number().int().min(1000).max(20000).default(10000),
    searchTimeoutMs: z.number().int().min(1000).max(60000).default(25000),
    resultLimit: z.number().int().min(1).max(10).default(5),
    maxChars: z.number().int().min(500).max(8000).default(4000),
    readMethod: z.enum(["auto", "http", "browser"]).default("auto"),
    diagnostics: z.boolean().default(false),
  })
  .strict();
export type WebSettings = z.infer<typeof webSettingsSchema>;
export const DEFAULT_WEB_SETTINGS = webSettingsSchema.parse({});
export const webSearchArgsSchema = z
  .object({
    query: z.string().trim().min(1).max(512),
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict();
export const webReadArgsSchema = z
  .object({
    url: z.string().url().max(2048),
    method: z.enum(["auto", "http", "browser"]).optional(),
    maxChars: z.number().int().min(500).max(8000).optional(),
  })
  .strict();
export const searchResultSchema = z
  .object({
    title: z.string().min(1).max(180),
    url: z.string().url().max(2048),
    snippet: z.string().max(300).optional(),
    engine: searchEngineSchema,
    rank: z.number().int().min(1).max(100),
  })
  .strict();
export type WebSearchResult = z.infer<typeof searchResultSchema>;
export const engineOutcomeSchema = z.enum([
  "ok",
  "no_results",
  "blocked",
  "parse_error",
  "network_error",
  "timeout",
]);
export const searchEngineResultSchema = z
  .object({
    outcome: engineOutcomeSchema,
    results: z.array(searchResultSchema).max(10),
    code: z.string().max(64).optional(),
  })
  .strict();
export type EngineResult = z.infer<typeof searchEngineResultSchema>;
export type SearchAttempt = {
  engine: SearchEngineId;
  outcome: EngineResult["outcome"];
  resultCount: number;
  durationMs: number;
  code?: string;
};
export const renderedPageSchema = z
  .object({
    title: z.string().max(300).optional(),
    finalUrl: z.string().url().max(2048),
    text: z.string().max(8000),
    truncated: z.boolean(),
  })
  .strict();
export type RenderedPage = z.infer<typeof renderedPageSchema>;
export type BrowserClient = {
  searchEngine: (
    engine: SearchEngineId,
    query: string,
    limit: number,
    signal: AbortSignal,
  ) => Promise<EngineResult>;
  readRenderedPage: (
    url: string,
    maxChars: number,
    signal: AbortSignal,
  ) => Promise<RenderedPage>;
  close: () => Promise<void>;
};
const requestBase = z.object({ id: z.string().uuid() });
export const browserRequestSchema = z.discriminatedUnion("op", [
  requestBase
    .extend({
      op: z.literal("searchEngine"),
      engine: searchEngineSchema,
      query: z.string().min(1).max(512),
      limit: z.number().int().min(1).max(10),
      timeoutMs: z.number().int().min(1).max(60000),
    })
    .strict(),
  requestBase
    .extend({
      op: z.literal("readRenderedPage"),
      url: z.string().url().max(2048),
      maxChars: z.number().int().min(500).max(8000),
      timeoutMs: z.number().int().min(1).max(60000),
    })
    .strict(),
  requestBase
    .extend({ op: z.literal("cancel"), targetId: z.string().uuid() })
    .strict(),
  requestBase.extend({ op: z.literal("close") }).strict(),
]);
export type BrowserRequest = z.infer<typeof browserRequestSchema>;
export const browserResponseSchema = z.discriminatedUnion("ok", [
  requestBase
    .extend({
      ok: z.literal(true),
      value: z.union([searchEngineResultSchema, renderedPageSchema, z.null()]),
    })
    .strict(),
  requestBase
    .extend({ ok: z.literal(false), code: z.string().max(64) })
    .strict(),
]);
export const WEB_FRAME_LIMIT = 128 * 1024;
