import { describe, expect, it } from "vitest";
import { coordinateSearch } from "./search-coordinator";
import {
  DEFAULT_WEB_SETTINGS,
  webSettingsSchema,
  type BrowserClient,
  type EngineResult,
  type SearchEngineId,
} from "../../shared/web-contracts";

describe("configured finite Web fallback", () => {
  async function run(
    outcomes: EngineResult["outcome"][],
    engines: SearchEngineId[] = DEFAULT_WEB_SETTINGS.engines,
  ): Promise<{
    result: Awaited<ReturnType<typeof coordinateSearch>>;
    calls: SearchEngineId[];
  }> {
    const calls: SearchEngineId[] = [];
    const browser: BrowserClient = {
      close: async () => {},
      readRenderedPage: async () => {
        throw new Error("unexpected_read");
      },
      searchEngine: async (engine) => {
        const outcome = outcomes[calls.length];
        calls.push(engine);
        return {
          outcome,
          results:
            outcome === "ok"
              ? [
                  {
                    title: "Article",
                    url: "https://example.com/",
                    engine,
                    rank: 1,
                  },
                ]
              : [],
        };
      },
    };
    return {
      result: await coordinateSearch({
        query: "query",
        limit: 5,
        settings: { ...DEFAULT_WEB_SETTINGS, engines },
        browser,
      }),
      calls,
    };
  }
  it("stops on Google success", async () => {
    const result = await run(["ok"]);
    expect(result.calls).toEqual(["google"]);
    expect(result.result.status).toBe("success");
  });
  it("falls back once and twice without extra engine visits", async () => {
    expect((await run(["blocked", "ok"])).calls).toEqual([
      "google",
      "duckduckgo",
    ]);
    const result = await run(["blocked", "parse_error", "ok"]);
    expect(result.calls).toEqual(DEFAULT_WEB_SETTINGS.engines);
    expect(result.result.status).toBe("success");
  });
  it("settles all-blocked and mixed failures distinctly", async () => {
    expect((await run(["blocked", "blocked", "blocked"])).result.code).toBe(
      "search_blocked_all",
    );
    expect((await run(["blocked", "timeout", "parse_error"])).result.code).toBe(
      "search_all_engines_failed",
    );
  });
  it("recognizes a valid empty outcome even when another engine is unavailable", async () => {
    const result = await run(["no_results", "blocked", "network_error"]);
    expect(result.result.status).toBe("success");
    expect(result.result.code).toBe("no_results");
  });
  it("honors reordered/disabled engines and rejects an empty set", async () => {
    expect((await run(["blocked", "ok"], ["bing", "google"])).calls).toEqual([
      "bing",
      "google",
    ]);
    expect(webSettingsSchema.safeParse({ engines: [] }).success).toBe(false);
  });
  it("does not consult engines after cancellation", async () => {
    const abort = new AbortController();
    abort.abort();
    const browser: BrowserClient = {
      close: async () => {},
      searchEngine: async () => {
        throw new Error("must_not_run");
      },
      readRenderedPage: async () => {
        throw new Error("must_not_run");
      },
    };
    expect(
      (
        await coordinateSearch({
          query: "query",
          limit: 5,
          settings: DEFAULT_WEB_SETTINGS,
          browser,
          signal: abort.signal,
        })
      ).status,
    ).toBe("cancelled");
  });
});
