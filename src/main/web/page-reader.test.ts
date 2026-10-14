import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WEB_SETTINGS,
  type BrowserClient,
} from "../../shared/web-contracts";
import { readPublicPage, retrievePublicHtml } from "./page-reader";

const network = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock("node:http", async () => ({
  ...(await vi.importActual<typeof import("node:http")>("node:http")),
  request: network.request,
}));
vi.mock("node:https", () => ({ request: network.request }));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));

type Page = {
  status?: number;
  headers?: Record<string, string | undefined>;
  body: string | Buffer;
};
function respond(...pages: Page[]): void {
  network.request.mockImplementation((_url, options, callback) => {
    const page = pages.shift();
    if (!page) throw new Error("unexpected_request");
    const request = Object.assign(new EventEmitter(), {
      end: (): void => {
        queueMicrotask(() => {
          const response = Object.assign(new PassThrough(), {
            statusCode: page.status ?? 200,
            headers: { "content-type": "text/html", ...page.headers },
          });
          callback(response);
          setImmediate(() => response.end(page.body));
        });
      },
      destroy: (): void => {},
    });
    expect(options.lookup).toBeTypeOf("function");
    options.lookup("example.com", {}, (_error, address) =>
      expect(address).toBe("8.8.8.8"),
    );
    options.lookup("example.com", { all: true }, (_error, addresses) =>
      expect(addresses).toEqual([{ address: "8.8.8.8", family: 4 }]),
    );
    return request;
  });
}
const html = `<html><head><title>Article</title></head><body><article><h1>Article</h1><p>${"Readable public text. ".repeat(100)}</p></article></body></html>`;
function browser(): BrowserClient {
  return {
    searchEngine: vi.fn(),
    readRenderedPage: vi.fn().mockResolvedValue({
      title: "Rendered",
      finalUrl: "https://example.com/final",
      text: "Rendered source content",
      truncated: false,
    }),
    close: vi.fn(),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  network.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});
describe("public page reading", () => {
  it("uses HTTP for ordinary articles, truncates text and avoids starting the browser", async () => {
    respond({ body: html });
    const client = browser();
    const result = await readPublicPage({
      url: "https://example.com/article",
      maxChars: 500,
      method: "auto",
      settings: DEFAULT_WEB_SETTINGS,
      browser: client,
    });
    expect(result).toMatchObject({
      status: "success",
      data: {
        method: "http",
        title: "Article",
        truncated: true,
        untrusted: true,
      },
    });
    expect(client.readRenderedPage).not.toHaveBeenCalled();
    expect(JSON.stringify(result.data)).not.toContain("<script");
  });
  it("renders insufficient JS pages and preserves the browser's final URL", async () => {
    respond({
      body: '<html><body><div id="app"></div><script src="/app.js"></script></body></html>',
    });
    const client = browser();
    const result = await readPublicPage({
      url: "https://example.com/app",
      maxChars: 500,
      method: "auto",
      settings: DEFAULT_WEB_SETTINGS,
      browser: client,
    });
    expect(result).toMatchObject({
      status: "success",
      data: { method: "browser", finalUrl: "https://example.com/final" },
    });
    expect(client.readRenderedPage).toHaveBeenCalledOnce();
  });
  it("reports empty HTTP-only content without rendering", async () => {
    respond({ body: "<html><body></body></html>" });
    const client = browser();
    expect(
      await readPublicPage({
        url: "https://example.com/",
        maxChars: 500,
        method: "http",
        settings: DEFAULT_WEB_SETTINGS,
        browser: client,
      }),
    ).toMatchObject({ status: "error", code: "empty_page" });
    expect(client.readRenderedPage).not.toHaveBeenCalled();
  });
  it("validates every redirect and pins each HTTP connection to validated DNS", async () => {
    respond(
      { status: 302, headers: { location: "/final" }, body: "" },
      { body: html },
    );
    expect(
      (
        await retrievePublicHtml(
          "https://example.com/",
          new AbortController().signal,
        )
      ).finalUrl,
    ).toBe("https://example.com/final");
    respond({
      status: 302,
      headers: { location: "http://127.0.0.1/secret" },
      body: "",
    });
    await expect(
      retrievePublicHtml("https://example.com/", new AbortController().signal),
    ).rejects.toThrow("unsafe_url");
    expect(network.request).toHaveBeenCalledTimes(3);
  });
  it.each([
    {
      headers: { "content-type": "application/octet-stream" },
      body: "binary",
      code: "content_type",
    },
    {
      headers: { "content-length": String(1024 * 1024 + 1) },
      body: "",
      code: "page_too_large",
    },
    {
      headers: { "content-encoding": "gzip" },
      body: gzipSync("x".repeat(2 * 1024 * 1024 + 1)),
      code: "page_too_large",
    },
  ])(
    "rejects unsafe or excessive content: $code",
    async ({ code, ...page }) => {
      respond(page);
      await expect(
        retrievePublicHtml(
          "https://example.com/",
          new AbortController().signal,
        ),
      ).rejects.toThrow(code);
    },
  );
  it("rejects DNS rebinding/private answers and cancellation before any request", async () => {
    network.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(
      retrievePublicHtml("https://example.com/", new AbortController().signal),
    ).rejects.toThrow("unsafe_address");
    const controller = new AbortController();
    controller.abort();
    const result = await readPublicPage({
      url: "https://example.com/",
      maxChars: 500,
      method: "auto",
      settings: DEFAULT_WEB_SETTINGS,
      browser: browser(),
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(network.request).not.toHaveBeenCalled();
  });
});
