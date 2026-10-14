import type { ActionResult } from "../../shared/action-contract";
import {
  searchEngineResultSchema,
  type BrowserClient,
  type SearchAttempt,
  type WebSettings,
} from "../../shared/web-contracts";
import { publicUrl } from "../../shared/public-network";
import { webSourceId } from "./source-reference";

export async function coordinateSearch(input: {
  query: string;
  limit: number;
  settings: WebSettings;
  browser: BrowserClient;
  signal?: AbortSignal;
  progress?: (text: string) => void;
}): Promise<ActionResult> {
  const started = Date.now();
  const attempts: SearchAttempt[] = [];
  const timeout = AbortSignal.timeout(input.settings.searchTimeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  for (const engine of input.settings.engines) {
    if (signal.aborted) break;
    input.progress?.(
      `Searching ${engine === "duckduckgo" ? "DuckDuckGo" : engine === "google" ? "Google" : "Bing"}`,
    );
    const attemptStarted = Date.now();
    const perEngine = AbortSignal.any([
      signal,
      AbortSignal.timeout(input.settings.engineTimeoutMs),
    ]);
    try {
      const value = searchEngineResultSchema.parse(
        await Promise.race([
          input.browser.searchEngine(
            engine,
            input.query,
            Math.min(input.limit, input.settings.resultLimit),
            perEngine,
          ),
          new Promise<never>((_resolve, reject) => {
            perEngine.addEventListener(
              "abort",
              () => reject(new Error("timeout")),
              { once: true },
            );
          }),
        ]),
      );
      const seen = new Set<string>();
      let resultChars = 0;
      const results = value.results
        .filter((result) => {
          try {
            publicUrl(result.url);
            if (result.engine !== engine || seen.has(result.url)) return false;
            seen.add(result.url);
            return true;
          } catch {
            return false;
          }
        })
        .slice(0, Math.min(input.limit, input.settings.resultLimit))
        .map((result) => ({ ...result, sourceId: webSourceId(result.url) }))
        .filter((result) => {
          resultChars += JSON.stringify(result).length;
          return resultChars <= 12000;
        });
      const outcome =
        value.outcome === "ok" && !results.length
          ? "parse_error"
          : value.outcome;
      attempts.push({
        engine,
        outcome,
        resultCount: results.length,
        durationMs: Date.now() - attemptStarted,
        ...(value.code ? { code: value.code } : {}),
      });
      if (outcome === "ok" && results.length)
        return {
          action: "web.search",
          status: "success",
          summary: `Found ${results.length} results using ${engine}.`,
          data: { results, attempts, engine, elapsedMs: Date.now() - started },
          totalItems: results.length,
        };
      if (engine !== input.settings.engines.at(-1))
        input.progress?.(
          `${engine} ${outcome.replaceAll("_", " ")}; trying the next enabled engine.`,
        );
    } catch (error) {
      const code =
        error instanceof Error && /^[a-z_]{1,64}$/.test(error.message)
          ? error.message
          : "browser_failed";
      attempts.push({
        engine,
        outcome:
          perEngine.aborted || code === "timeout" ? "timeout" : "network_error",
        code,
        resultCount: 0,
        durationMs: Date.now() - attemptStarted,
      });
    }
  }
  if (input.signal?.aborted)
    return {
      action: "web.search",
      status: "cancelled",
      code: "cancelled",
      summary: "Search cancelled.",
      data: { results: [], attempts },
    };
  if (attempts.some((attempt) => attempt.outcome === "no_results"))
    return {
      action: "web.search",
      status: "success",
      code: "no_results",
      summary: "The search engines that completed this query found no results.",
      data: { results: [], attempts },
      totalItems: 0,
    };
  const blocked =
    attempts.length === input.settings.engines.length &&
    attempts.every((attempt) => attempt.outcome === "blocked");
  return {
    action: "web.search",
    status: "error",
    code: blocked ? "search_blocked_all" : "search_all_engines_failed",
    summary: blocked
      ? "All enabled search engines blocked this search."
      : "None of the enabled search engines could complete this search.",
    data: { results: [], attempts, elapsedMs: Date.now() - started },
  };
}
