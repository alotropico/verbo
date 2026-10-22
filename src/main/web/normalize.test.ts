import { describe, expect, it } from "vitest";
import { normalizeOrganicResults, normalizeUrl } from "./normalize";

describe("normalize", () => {
  describe("normalizeUrl", () => {
    it("normalizes a standard public HTTPS URL", () => {
      expect(normalizeUrl("https://example.com/path?b=2&a=1#section")).toBe("https://example.com/path?a=1&b=2");
    });

    it("removes tracking parameters case-insensitively", () => {
      expect(normalizeUrl("https://example.com/article?utm_source=twitter&UTM_MEDIUM=social&GCLID=123&fbclid=abc&q=test")).toBe(
        "https://example.com/article?q=test",
      );
    });

    it("rejects non-http(s) schemes, credentials, and non-standard ports", () => {
      expect(normalizeUrl("ftp://example.com/file")).toBeNull();
      expect(normalizeUrl("javascript:alert(1)")).toBeNull();
      expect(normalizeUrl("https://user:pass@example.com/")).toBeNull();
      expect(normalizeUrl("https://example.com:8080/")).toBeNull();
    });

    it("rejects local, loopback, and private hostnames or IPs", () => {
      expect(normalizeUrl("http://localhost/path")).toBeNull();
      expect(normalizeUrl("http://127.0.0.1:80/")).toBeNull();
      expect(normalizeUrl("http://192.168.1.1/")).toBeNull();
      expect(normalizeUrl("http://10.0.0.1/")).toBeNull();
      expect(normalizeUrl("http://myhost.local/")).toBeNull();
    });

    it("rejects URLs over 4096 characters", () => {
      const longUrl = "https://example.com/path?" + "a=".repeat(2050);
      expect(normalizeUrl(longUrl)).toBeNull();
    });

    it("preserves meaningful path and query distinctions and scheme", () => {
      const http = normalizeUrl("http://example.com/page");
      const https = normalizeUrl("https://example.com/page");
      expect(http).toBe("http://example.com/page");
      expect(https).toBe("https://example.com/page");
      expect(http).not.toBe(https);
    });
  });

  describe("normalizeOrganicResults", () => {
    it("drops rows with missing or invalid fields", () => {
      const rows = [
        null,
        "not-an-object",
        { title: "No URL", engine: "duckduckgo" },
        { url: "https://example.com", engine: "duckduckgo" }, // missing title
        { title: "   ", url: "https://example.com", engine: "duckduckgo" }, // empty title
        { title: "Title", url: "https://example.com", engine: "unknown_eng" }, // invalid engine
        { title: "Unsafe", url: "http://localhost:8080", engine: "duckduckgo" }, // unsafe URL
      ];
      expect(normalizeOrganicResults(rows, 240)).toEqual([]);
    });

    it("deduplicates results by clean URL retaining first-seen rank", () => {
      const rows = [
        {
          title: "First Title",
          url: "https://example.com/page?utm_source=news#header",
          snippet: "First Snippet",
          engine: "duckduckgo",
        },
        {
          title: "Second Title (Duplicate)",
          url: "https://example.com/page",
          snippet: "Second Snippet",
          engine: "brave",
        },
      ];
      const res = normalizeOrganicResults(rows, 240);
      expect(res).toHaveLength(1);
      expect(res[0].title).toBe("First Title");
      expect(res[0].engine).toBe("duckduckgo");
      expect(res[0].url).toBe("https://example.com/page");
    });

    it("collapses whitespace and truncates title to 180 Unicode code points", () => {
      const longEmojiTitle = "✨ ".repeat(150); // 300 characters, exceeds 180 code points
      const rows = [
        {
          title: `  Lots   of  \n  whitespace \t ${longEmojiTitle} `,
          url: "https://example.com/unicode",
          snippet: "ok",
          engine: "bing",
        },
      ];
      const res = normalizeOrganicResults(rows, 240);
      expect(res).toHaveLength(1);
      expect(res[0].title.startsWith("Lots of whitespace ✨")).toBe(true);
      expect(Array.from(res[0].title).length).toBe(180);
    });

    it("collapses whitespace, allows empty snippet, and truncates snippet to maxSnippetChars", () => {
      const rows = [
        {
          title: "Title",
          url: "https://example.com/empty-snippet",
          snippet: "",
          engine: "wikipedia",
        },
        {
          title: "Title 2",
          url: "https://example.com/long-snippet",
          snippet: "a ".repeat(200),
          engine: "github",
        },
      ];
      const res = normalizeOrganicResults(rows, 100);
      expect(res).toHaveLength(2);
      expect(res[0].snippet).toBe("");
      expect(Array.from(res[1].snippet).length).toBe(100);
    });
  });
});
