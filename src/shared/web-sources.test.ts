import { describe, expect, it } from "vitest";
import { webSourcesFromResult } from "./web-sources";
import { webSourceId } from "../main/web/source-reference";

describe("deterministic web source references", () => {
  it("keeps page URLs separate from local attachments and distinguishes search leads from read content", () => {
    const sourceId = webSourceId("https://example.com/article");
    expect(webSourceId("https://example.com/article#section")).toBe(sourceId);
    expect(
      webSourcesFromResult({
        action: "web.search",
        status: "success",
        data: {
          results: [
            { sourceId, url: "https://example.com/article", title: "Article" },
          ],
        },
      }),
    ).toEqual([
      {
        sourceId,
        url: "https://example.com/article",
        title: "Article",
        kind: "lead",
      },
    ]);
    expect(
      webSourcesFromResult({
        action: "web.read",
        status: "success",
        data: {
          sourceId,
          finalUrl: "https://example.com/article",
          title: "Article",
        },
      })[0].kind,
    ).toBe("page");
    expect(
      webSourcesFromResult({
        action: "web.read",
        status: "error",
        data: { sourceId, finalUrl: "https://example.com/article" },
      }),
    ).toEqual([]);
  });
  it("rejects local-file and executable schemes even in malformed historical data", () => {
    for (const url of [
      "file:///C:/secret.txt",
      "javascript:alert(1)",
      "https://user:password@example.com/",
    ]) {
      expect(() => webSourceId(url)).toThrow();
      expect(
        webSourcesFromResult({
          action: "web.read",
          status: "success",
          data: { sourceId: `web:${"a".repeat(64)}`, finalUrl: url },
        }),
      ).toEqual([]);
    }
  });
});
