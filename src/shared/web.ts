import { z } from "zod";

export const WEB_IDENTITY = "verbo-web";
export const WEB_API_VERSION = "1";
export const DEFAULT_WEB_BASE_URL = "http://127.0.0.1:8766";

export const allowedEngines = ["duckduckgo", "brave", "bing", "google", "wikipedia", "github"] as const;
export type EngineId = (typeof allowedEngines)[number];

export const allowedCategories = ["general", "it", "science", "news"] as const;
export type Category = (typeof allowedCategories)[number];

export const engineIdSchema = z.enum(allowedEngines);
export const categorySchema = z.enum(allowedCategories);

export const organicResultSchema = z
  .object({
    title: z.string(),
    url: z.string(),
    snippet: z.string(),
    engine: engineIdSchema,
  })
  .strict();
export type OrganicResult = z.infer<typeof organicResultSchema>;

export const engineFailureSchema = z
  .object({
    engine: engineIdSchema,
    error: z.string().max(200),
  })
  .strict();
export type EngineFailure = z.infer<typeof engineFailureSchema>;

export const serviceSearchInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(2048)
      .refine((s) => s.trim().length > 0, "Query cannot be whitespace-only"),
    engines: z
      .array(engineIdSchema)
      .min(1)
      .max(6)
      .refine((arr) => new Set(arr).size === arr.length, "Engines must be unique")
      .optional(),
    category: categorySchema.optional(),
    pageno: z.number().int().min(1).max(100).optional(),
    timeoutMs: z.number().int().min(2000).max(20000).optional(),
  })
  .strict();
export type ServiceSearchInput = z.infer<typeof serviceSearchInputSchema>;

export const serviceSearchOutputSchema = z
  .object({
    results: z.array(organicResultSchema),
    unresponsiveEngines: z.array(engineFailureSchema),
  })
  .strict();
export type ServiceSearchOutput = z.infer<typeof serviceSearchOutputSchema>;

export type SearchInput = {
  query: string;
  pageSize?: number;
  category?: Category;
  signal?: AbortSignal;
};

export type NextInput = {
  cursor: string;
  pageSize?: number;
  signal?: AbortSignal;
};

export type SearchPage = {
  ok: true;
  query: string;
  results: OrganicResult[];
  returnedCount: number;
  totalCached: number;
  hasMore: boolean;
  nextCursor?: string;
  enginesUsed: EngineId[];
  unresponsiveEngines: EngineFailure[];
};

export type WebFailureCode =
  | "invalid_request"
  | "offline"
  | "unauthorized"
  | "incompatible"
  | "not_ready"
  | "busy"
  | "timeout"
  | "cancelled"
  | "bad_response"
  | "upstream_error"
  | "cursor_expired";

export type WebFailure = {
  ok: false;
  code: WebFailureCode;
  detail: string;
};

export type WebSearchResult = SearchPage | WebFailure;

export type WebStatus =
  | {
      ok: true;
      identity: typeof WEB_IDENTITY;
      apiVersion: typeof WEB_API_VERSION;
      ready: boolean;
      engines: EngineId[];
      detail?: string;
    }
  | {
      ok: false;
      code: "offline" | "unauthorized" | "incompatible" | "bad_response";
      detail: string;
    };

export function parseWebBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Web URL is invalid.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new Error("Web URL must be http://127.0.0.1:<port>.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Web URL must be an origin only.");
  }
  return url.origin;
}
