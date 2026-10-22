import { z } from "zod";
import { allowedEngines, engineIdSchema, type EngineId } from "./web";

export const WEB_SETTINGS_EVENT = "verbo:web-settings";

export const webSettingsSchema = z
  .object({
    engines: z
      .array(engineIdSchema)
      .min(1)
      .max(6)
      .refine((arr) => new Set(arr).size === arr.length, "Engines must be unique"),
    pageSize: z.number().int().min(1).max(10),
    maxSnippetChars: z.number().int().min(100).max(500),
    timeoutMs: z.number().int().min(2000).max(20000),
  })
  .strict();

export type WebSettings = z.infer<typeof webSettingsSchema>;

export type DefaultWebSettings = Readonly<{
  engines: readonly EngineId[];
  pageSize: number;
  maxSnippetChars: number;
  timeoutMs: number;
}>;

export const DEFAULT_WEB_SETTINGS: DefaultWebSettings = Object.freeze({
  engines: Object.freeze(["duckduckgo", "brave", "bing"] as EngineId[]),
  pageSize: 5,
  maxSnippetChars: 240,
  timeoutMs: 8000,
});

export function getDefaultWebSettings(): WebSettings {
  return {
    engines: [...DEFAULT_WEB_SETTINGS.engines],
    pageSize: DEFAULT_WEB_SETTINGS.pageSize,
    maxSnippetChars: DEFAULT_WEB_SETTINGS.maxSnippetChars,
    timeoutMs: DEFAULT_WEB_SETTINGS.timeoutMs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recoverWebSettings(raw: unknown): WebSettings {
  const parsed = webSettingsSchema.safeParse(raw);
  if (parsed.success) {
    return {
      ...parsed.data,
      engines: [...parsed.data.engines],
    };
  }
  if (!isRecord(raw)) {
    return getDefaultWebSettings();
  }

  const next = getDefaultWebSettings();

  // Validate engines individually
  if (Array.isArray(raw.engines)) {
    const validEngines: EngineId[] = [];
    const seen = new Set<string>();
    for (const item of raw.engines) {
      if (typeof item === "string" && allowedEngines.includes(item as EngineId) && !seen.has(item) && validEngines.length < 6) {
        seen.add(item);
        validEngines.push(item as EngineId);
      }
    }
    if (validEngines.length > 0) {
      next.engines = validEngines;
    }
  }

  if (typeof raw.pageSize === "number" && Number.isInteger(raw.pageSize) && raw.pageSize >= 1 && raw.pageSize <= 10) {
    next.pageSize = raw.pageSize;
  }

  if (
    typeof raw.maxSnippetChars === "number" &&
    Number.isInteger(raw.maxSnippetChars) &&
    raw.maxSnippetChars >= 100 &&
    raw.maxSnippetChars <= 500
  ) {
    next.maxSnippetChars = raw.maxSnippetChars;
  }

  if (typeof raw.timeoutMs === "number" && Number.isInteger(raw.timeoutMs) && raw.timeoutMs >= 2000 && raw.timeoutMs <= 20000) {
    next.timeoutMs = raw.timeoutMs;
  }

  return next;
}

export function sameWebSettings(left: WebSettings, right: WebSettings): boolean {
  if (
    left.pageSize !== right.pageSize ||
    left.maxSnippetChars !== right.maxSnippetChars ||
    left.timeoutMs !== right.timeoutMs ||
    left.engines.length !== right.engines.length
  ) {
    return false;
  }
  for (let i = 0; i < left.engines.length; i++) {
    if (left.engines[i] !== right.engines[i]) {
      return false;
    }
  }
  return true;
}
