import { describe, expect, it } from "vitest";
import {
  allowedCategories,
  allowedEngines,
  DEFAULT_WEB_BASE_URL,
  engineFailureSchema,
  organicResultSchema,
  parseWebBaseUrl,
  serviceSearchInputSchema,
  serviceSearchOutputSchema,
  WEB_API_VERSION,
  WEB_IDENTITY,
} from "./web";

describe("web shared contracts", () => {
  it("defines expected constants", () => {
    expect(WEB_IDENTITY).toBe("verbo-web");
    expect(WEB_API_VERSION).toBe("1");
    expect(DEFAULT_WEB_BASE_URL).toBe("http://127.0.0.1:8766");
    expect(allowedEngines).toEqual(["duckduckgo", "brave", "bing", "google", "wikipedia", "github"]);
    expect(allowedCategories).toEqual(["general", "it", "science", "news"]);
  });

  describe("parseWebBaseUrl", () => {
    it("accepts valid loopback origin", () => {
      expect(parseWebBaseUrl("http://127.0.0.1:8766")).toBe("http://127.0.0.1:8766");
      expect(parseWebBaseUrl("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
    });

    it("rejects non-loopback hostnames or other loopbacks", () => {
      expect(() => parseWebBaseUrl("http://localhost:8766")).toThrow(/127\.0\.0\.1/);
      expect(() => parseWebBaseUrl("http://0.0.0.0:8766")).toThrow(/127\.0\.0\.1/);
      expect(() => parseWebBaseUrl("http://192.168.1.1:8766")).toThrow(/127\.0\.0\.1/);
    });

    it("rejects non-http protocols", () => {
      expect(() => parseWebBaseUrl("https://127.0.0.1:8766")).toThrow(/http:/);
    });

    it("rejects URLs with paths, queries, fragments, or credentials", () => {
      expect(() => parseWebBaseUrl("http://127.0.0.1:8766/v1")).toThrow(/origin/);
      expect(() => parseWebBaseUrl("http://127.0.0.1:8766?test=1")).toThrow(/origin/);
      expect(() => parseWebBaseUrl("http://127.0.0.1:8766#hash")).toThrow(/origin/);
      expect(() => parseWebBaseUrl("http://user:pass@127.0.0.1:8766")).toThrow(/origin/);
    });
  });

  describe("serviceSearchInputSchema", () => {
    it("validates a minimal valid search input", () => {
      const parsed = serviceSearchInputSchema.safeParse({ query: "hello world" });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.query).toBe("hello world");
      }
    });

    it("rejects empty or whitespace query", () => {
      expect(serviceSearchInputSchema.safeParse({ query: "" }).success).toBe(false);
      expect(serviceSearchInputSchema.safeParse({ query: "   " }).success).toBe(false);
    });

    it("rejects query longer than 2048 chars", () => {
      expect(serviceSearchInputSchema.safeParse({ query: "a".repeat(2049) }).success).toBe(false);
    });

    it("rejects duplicate or invalid engines", () => {
      expect(
        serviceSearchInputSchema.safeParse({
          query: "test",
          engines: ["duckduckgo", "duckduckgo"],
        }).success,
      ).toBe(false);
      expect(
        serviceSearchInputSchema.safeParse({
          query: "test",
          engines: ["unknown"],
        }).success,
      ).toBe(false);
    });

    it("rejects invalid page or timeout boundaries", () => {
      expect(serviceSearchInputSchema.safeParse({ query: "test", pageno: 0 }).success).toBe(false);
      expect(serviceSearchInputSchema.safeParse({ query: "test", pageno: 101 }).success).toBe(false);
      expect(serviceSearchInputSchema.safeParse({ query: "test", timeoutMs: 1999 }).success).toBe(false);
      expect(serviceSearchInputSchema.safeParse({ query: "test", timeoutMs: 20001 }).success).toBe(false);
    });
  });

  describe("organicResultSchema & engineFailureSchema", () => {
    it("validates organic result", () => {
      const res = {
        title: "Test",
        url: "https://example.com",
        snippet: "Snippet",
        engine: "duckduckgo",
      };
      expect(organicResultSchema.safeParse(res).success).toBe(true);
      expect(organicResultSchema.safeParse({ ...res, extra: true }).success).toBe(false);
    });

    it("validates engine failure", () => {
      const fail = { engine: "brave", error: "timeout" };
      expect(engineFailureSchema.safeParse(fail).success).toBe(true);
      expect(engineFailureSchema.safeParse({ engine: "brave", error: "x".repeat(201) }).success).toBe(false);
    });

    it("validates service search output", () => {
      const output = {
        results: [
          {
            title: "Test",
            url: "https://example.com",
            snippet: "Snippet",
            engine: "duckduckgo",
          },
        ],
        unresponsiveEngines: [{ engine: "bing", error: "err" }],
      };
      expect(serviceSearchOutputSchema.safeParse(output).success).toBe(true);
    });
  });
});
