import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSearchPage, normalizeDestination } from "../src/engines/parsers";

describe("organic engine adapters", () => {
  it.each([
    [
      "google",
      "https://notgoogle.com/url?q=https%3A%2F%2Fexample.com%2Farticle",
    ],
    [
      "duckduckgo",
      "https://notduckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle",
    ],
    [
      "bing",
      `https://notbing.com/ck/a?u=a1${Buffer.from("https://example.com/article").toString("base64url")}`,
    ],
  ] as const)(
    "does not treat a suffix lookalike as a trusted %s redirect",
    (engine, url) => {
      expect(normalizeDestination(url, engine)).toBe(url);
    },
  );
  it("parses the verified live Bing layout and unwraps organic destinations", () => {
    const result = parseSearchPage(
      "bing",
      readFileSync(
        join(import.meta.dirname, "fixtures", "bing-live.html"),
        "utf8",
      ),
      3,
    );
    expect(result.outcome).toBe("ok");
    expect(
      result.results.map(({ title, url, engine, rank }) => ({
        title,
        url,
        engine,
        rank,
      })),
    ).toEqual([
      {
        title: "Welcome to Python.org",
        url: "https://www.python.org/",
        engine: "bing",
        rank: 1,
      },
      {
        title: "Download Python | Python.org",
        url: "https://www.python.org/downloads/",
        engine: "bing",
        rank: 2,
      },
      {
        title: "Online Python - IDE, Editor, Compiler, Interpreter",
        url: "https://www.online-python.com/",
        engine: "bing",
        rank: 3,
      },
    ]);
  });
  for (const engine of ["google", "duckduckgo", "bing"] as const) {
    it(`parses ${engine} organic results, excludes ads/unsafe links and preserves provenance`, () => {
      const result = parseSearchPage(
        engine,
        readFileSync(
          join(import.meta.dirname, "fixtures", `${engine}.html`),
          "utf8",
        ),
        5,
      );
      expect(result).toEqual({
        outcome: "ok",
        results: [
          {
            title: "Useful article",
            url: "https://example.com/article",
            snippet: "A useful snippet.",
            engine,
            rank: 1,
          },
        ],
      });
    });
    it(`distinguishes ${engine} blocking, legitimate emptiness and layout failure`, () => {
      expect(
        parseSearchPage(
          engine,
          "<html><body>Verify you are human CAPTCHA</body></html>",
          5,
        ).outcome,
      ).toBe("blocked");
      expect(
        parseSearchPage(engine, "<html><body>No results found</body></html>", 5)
          .outcome,
      ).toBe("no_results");
      expect(
        parseSearchPage(
          engine,
          "<html><body>Unexpected layout</body></html>",
          5,
        ).outcome,
      ).toBe("parse_error");
    });
  }
  it("unwraps Bing destinations without requesting tracking URLs", () => {
    const url = `https://www.bing.com/ck/a?u=a1${Buffer.from("https://example.com/article").toString("base64url")}`;
    expect(normalizeDestination(url, "bing")).toBe(
      "https://example.com/article",
    );
    expect(
      normalizeDestination("https://www.bing.com/ck/a?u=broken", "bing"),
    ).toBe(null);
  });
  it("uses rendered visible text to exclude CSS-hidden no-results messages", () => {
    expect(
      parseSearchPage(
        "bing",
        '<html><body><div class="hidden-by-css">No results found</div><main>Unexpected results layout</main></body></html>',
        5,
        200,
        "Unexpected results layout",
      ).outcome,
    ).toBe("parse_error");
  });
  it("ignores hidden no-result and CAPTCHA templates, without rejecting organic CAPTCHA articles", () => {
    expect(
      parseSearchPage(
        "bing",
        '<html><body><script>const empty="No results found"; const banner="Verify you are human"</script><div hidden>No results found</div><template>Complete this captcha</template></body></html>',
        5,
      ).outcome,
    ).toBe("parse_error");
    expect(
      parseSearchPage(
        "bing",
        '<html><body><li class="b_algo"><h2><a href="https://example.com/captcha">What is CAPTCHA?</a></h2></li></body></html>',
        5,
      ).outcome,
    ).toBe("ok");
  });
});
