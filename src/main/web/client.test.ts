import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WEB_SETTINGS, type WebSettings } from "../../shared/web-settings";
import { createWebClient } from "./client";

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("web client", () => {
  it.each([200, 503])("keeps cancellation during an HTTP %s body read", async (status) => {
    const caller = new AbortController();
    const client = createWebClient({
      token: "token-16-chars-long",
      getSettings: () => DEFAULT_WEB_SETTINGS,
      fetchImpl: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
              setTimeout(() => caller.abort(), 0);
            },
          }),
          { status },
        ),
    });
    expect(await client.search({ query: "test", signal: caller.signal })).toMatchObject({ ok: false, code: "cancelled" });
  });

  it.each([200, 503])("keeps the deadline failure during an HTTP %s body read", async (status) => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      const client = createWebClient({
        token: "token-16-chars-long",
        getSettings: () => DEFAULT_WEB_SETTINGS,
        fetchImpl: async (_url, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
                setTimeout(() => deadline.abort(new DOMException("deadline", "TimeoutError")), 0);
              },
            }),
            { status },
          ),
      });
      expect(await client.search({ query: "test" })).toMatchObject({ ok: false, code: "timeout" });
    } finally {
      timeout.mockRestore();
    }
  });

  it("status returns health when service is compatible", async () => {
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;

    const client = createWebClient({
      token: "test-token-16-chars-long",
      getSettings: () => DEFAULT_WEB_SETTINGS,
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = init?.headers;
        return jsonResponse({
          identity: "verbo-web",
          apiVersion: "1",
          ready: true,
          engines: ["duckduckgo", "brave", "bing"],
        });
      },
    });

    const res = await client.status();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.identity).toBe("verbo-web");
      expect(res.ready).toBe(true);
      expect(res.engines).toEqual(["duckduckgo", "brave", "bing"]);
    }
    expect(capturedUrl).toBe("http://127.0.0.1:8766/v1/health");
    expect((capturedHeaders as Record<string, string>)?.Authorization).toBe("Bearer test-token-16-chars-long");
  });

  it("status returns unauthorized without calling fetch when token is missing", async () => {
    let called = false;
    const client = createWebClient({
      readToken: () => null,
      getSettings: () => DEFAULT_WEB_SETTINGS,
      fetchImpl: async () => {
        called = true;
        return jsonResponse({});
      },
    });

    const res = await client.status();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("unauthorized");
    }
    expect(called).toBe(false);
  });

  it("status returns offline when connection fails", async () => {
    const client = createWebClient({
      token: "test-token-16-chars-long",
      getSettings: () => DEFAULT_WEB_SETTINGS,
      fetchImpl: async () => {
        const err = new TypeError("fetch failed");
        Object.assign(err, { cause: { code: "ECONNREFUSED" } });
        throw err;
      },
    });

    const res = await client.status();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("offline");
    }
  });

  it("search sends bearer token and settings payload, returning first page", async () => {
    let requestPayload: Record<string, unknown> | null = null;
    let authHeader = "";

    const client = createWebClient({
      token: "valid-bearer-token-12345",
      getSettings: () => ({
        engines: ["duckduckgo", "brave"],
        pageSize: 5,
        maxSnippetChars: 240,
        timeoutMs: 8000,
      }),
      fetchImpl: async (_url, init) => {
        authHeader = (init?.headers as Record<string, string>)?.Authorization ?? "";
        requestPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          results: [
            {
              title: "Page 1",
              url: "https://example.com/1",
              snippet: "Snippet 1",
              engine: "duckduckgo",
            },
            {
              title: "Page 2",
              url: "https://example.com/2",
              snippet: "Snippet 2",
              engine: "brave",
            },
          ],
          unresponsiveEngines: [{ engine: "bing", error: "timeout" }],
        });
      },
    });

    const res = await client.search({ query: "vitest testing" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.query).toBe("vitest testing");
      expect(res.returnedCount).toBe(2);
      expect(res.totalCached).toBe(2);
      expect(res.hasMore).toBe(false);
      expect(res.enginesUsed).toEqual(["duckduckgo", "brave"]);
      expect(res.unresponsiveEngines).toEqual([{ engine: "bing", error: "timeout" }]);
    }
    expect(authHeader).toBe("Bearer valid-bearer-token-12345");
    expect(requestPayload).toEqual({
      query: "vitest testing",
      engines: ["duckduckgo", "brave"],
      category: "general",
      pageno: 1,
      timeoutMs: 8000,
    });
  });

  it("isolates settings mutations so edits after search start do not affect current search", async () => {
    const mutableSettings: WebSettings = {
      engines: ["duckduckgo"],
      pageSize: 2,
      maxSnippetChars: 200,
      timeoutMs: 5000,
    };

    let capturedPayload: Record<string, unknown> | undefined;
    const client = createWebClient({
      token: "token-16-chars-long",
      getSettings: () => ({ ...mutableSettings, engines: [...mutableSettings.engines] }),
      fetchImpl: async (_url, init) => {
        capturedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        // Mutate original settings during search
        mutableSettings.pageSize = 10;
        mutableSettings.engines = ["bing"];
        return jsonResponse({
          results: Array.from({ length: 6 }, (_, i) => ({
            title: `Item ${i}`,
            url: `https://example.com/${i}`,
            snippet: "s",
            engine: "duckduckgo",
          })),
          unresponsiveEngines: [],
        });
      },
    });

    const res = await client.search({ query: "test" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.returnedCount).toBe(2); // captured pageSize was 2
      expect(res.enginesUsed).toEqual(["duckduckgo"]);
    }
    expect(capturedPayload?.pageSize).toBeUndefined(); // pageSize is handled client-side
    expect(capturedPayload?.engines).toEqual(["duckduckgo"]);
  });

  it("distinguishes caller cancellation from timeout", async () => {
    const client = createWebClient({
      token: "token-16-chars-long",
      getSettings: () => DEFAULT_WEB_SETTINGS,
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return jsonResponse({ results: [], unresponsiveEngines: [] });
      },
    });

    const ac = new AbortController();
    ac.abort();

    const cancelledRes = await client.search({ query: "test", signal: ac.signal });
    expect(cancelledRes.ok).toBe(false);
    if (!cancelledRes.ok) {
      expect(cancelledRes.code).toBe("cancelled");
    }

    const timeoutClient = createWebClient({
      token: "token-16-chars-long",
      getSettings: () => ({ ...DEFAULT_WEB_SETTINGS, timeoutMs: 2000 }),
      fetchImpl: async () => {
        const err = new Error("timeout");
        err.name = "TimeoutError";
        throw err;
      },
    });

    const timeoutRes = await timeoutClient.search({ query: "test" });
    expect(timeoutRes.ok).toBe(false);
    if (!timeoutRes.ok) {
      expect(timeoutRes.code).toBe("timeout");
    }
  });

  it("handles upstream 503 all engines failed as upstream_error", async () => {
    const client = createWebClient({
      token: "token-16-chars-long",
      getSettings: () => DEFAULT_WEB_SETTINGS,
      fetchImpl: async () => {
        return jsonResponse({ error: "upstream_error", detail: "All engines failed." }, 503);
      },
    });

    const res = await client.search({ query: "fail" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("upstream_error");
      expect(res.detail).toBe("All engines failed.");
    }
  });

  it("handles malformed JSON and oversized response as bad_response", async () => {
    const malformedClient = createWebClient({
      token: "token-16-chars-long",
      getSettings: () => DEFAULT_WEB_SETTINGS,
      fetchImpl: async () => {
        return new Response("not-json {", { status: 200 });
      },
    });

    const malformed = await malformedClient.search({ query: "test" });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.code).toBe("bad_response");
    }

    // Oversized response > 2 MiB
    const oversizedClient = createWebClient({
      token: "token-16-chars-long",
      getSettings: () => DEFAULT_WEB_SETTINGS,
      fetchImpl: async () => {
        const big = JSON.stringify({
          results: [],
          unresponsiveEngines: [],
          extra: "x".repeat(2.1 * 1024 * 1024),
        });
        return new Response(big, { status: 200 });
      },
    });

    const oversized = await oversizedClient.search({ query: "test" });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.code).toBe("bad_response");
    }
  });

  it("pagination performs only 1 HTTP search and works after service shutdown", async () => {
    let httpCalls = 0;
    let serviceOnline = true;

    const client = createWebClient({
      token: "token-16-chars-long",
      getSettings: () => ({ ...DEFAULT_WEB_SETTINGS, pageSize: 2 }),
      fetchImpl: async () => {
        if (!serviceOnline) {
          const err = new TypeError("fetch failed");
          Object.assign(err, { cause: { code: "ECONNREFUSED" } });
          throw err;
        }
        httpCalls++;
        return jsonResponse({
          results: Array.from({ length: 5 }, (_, i) => ({
            title: `Item ${i + 1}`,
            url: `https://example.com/${i + 1}`,
            snippet: `Snippet ${i + 1}`,
            engine: "duckduckgo",
          })),
          unresponsiveEngines: [],
        });
      },
    });

    // Page 1: performs HTTP search
    const page1 = await client.search({ query: "paginate" });
    expect(page1.ok).toBe(true);
    expect(httpCalls).toBe(1);
    if (!page1.ok) return;

    expect(page1.returnedCount).toBe(2);
    expect(page1.hasMore).toBe(true);
    const cursor1 = page1.nextCursor!;

    // Now simulate Python service shutdown!
    serviceOnline = false;

    // Page 2: works in-memory without any HTTP call!
    const page2 = await client.next({ cursor: cursor1 });
    expect(page2.ok).toBe(true);
    expect(httpCalls).toBe(1); // STILL 1!
    if (!page2.ok) return;

    expect(page2.returnedCount).toBe(2);
    expect(page2.results[0].title).toBe("Item 3");
    expect(page2.hasMore).toBe(true);
    const cursor2 = page2.nextCursor!;

    // Page 3: works in-memory without any HTTP call!
    const page3 = await client.next({ cursor: cursor2 });
    expect(page3.ok).toBe(true);
    expect(httpCalls).toBe(1); // STILL 1!
    if (!page3.ok) return;

    expect(page3.returnedCount).toBe(1);
    expect(page3.results[0].title).toBe("Item 5");
    expect(page3.hasMore).toBe(false);
  });
});
