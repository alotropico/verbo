import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchPageReady } from "../src/engines/readiness";

function page(html: string, visibleText = "Search navigation"): void {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  Object.defineProperty(document.body, "innerText", { value: visibleText });
  for (const node of document.querySelectorAll("*"))
    Object.defineProperty(node, "getClientRects", {
      value: () => (node.closest("[hidden]") ? [] : [{}]),
    });
  vi.stubGlobal("document", document);
  vi.stubGlobal("getComputedStyle", (node: Element) => ({
    display: node.hasAttribute("hidden") ? "none" : "block",
    visibility: "visible",
  }));
}
afterEach(() => vi.unstubAllGlobals());
describe("rendered search readiness", () => {
  it("waits through hidden no-results templates and empty result placeholders", () => {
    page(
      '<ol id="b_results"><li class="b_no" hidden>There are no results</li><li class="b_algo"><h2></h2></li></ol>',
    );
    expect(searchPageReady("bing")).toBe(false);
    page(
      '<h3>Sidebar widget</h3><li class="b_algo" hidden><h2><a href="https://example.com">Hidden result</a></h2></li>',
    );
    expect(searchPageReady("bing")).toBe(false);
  });
  it.each([
    [
      "bing",
      '<li class="b_algo"><h2><a href="https://example.com">Article</a></h2></li>',
    ],
    [
      "google",
      '<div class="MjjYud"><a href="https://example.com"><h3>Article</h3></a></div>',
    ],
    [
      "duckduckgo",
      '<div class="result"><h2 class="result__title"><a href="https://example.com">Article</a></h2></div>',
    ],
  ] as const)(
    "accepts a visible %s organic heading with a destination",
    (engine, html) => {
      page(html);
      expect(searchPageReady(engine)).toBe(true);
    },
  );
  it("accepts visible empty/block outcomes but ignores hidden challenge templates", () => {
    page('<form id="challenge-form" hidden></form>');
    expect(searchPageReady("duckduckgo")).toBe(false);
    page('<form id="challenge-form"></form>');
    expect(searchPageReady("duckduckgo")).toBe(true);
    page(
      '<li class="b_no">There are no results for this query</li>',
      "There are no results for this query",
    );
    expect(searchPageReady("bing")).toBe(true);
  });
});
