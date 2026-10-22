import { afterEach, describe, expect, it, vi } from "vitest";
import { probeOllama } from "./ollama-probe";

afterEach(() => vi.unstubAllGlobals());

describe("Ollama endpoint classification", () => {
  it("recognizes a healthy version response", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ version: "fixture" }));
    vi.stubGlobal("fetch", request);
    expect(await probeOllama()).toEqual({ state: "ready", version: "fixture" });
    expect(request.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/version");
  });

  it("marks only an explicit connection refusal as absent", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })));
    expect(await probeOllama()).toEqual({ state: "absent" });
  });

  it.each(["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EACCES"])("keeps %s distinct from a missing listener", async (code) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed", { cause: { code } })));
    expect((await probeOllama()).state).toBe("unresponsive");
  });

  it("does not classify mixed aggregate failures as definite absence", async () => {
    const error = Object.assign(new AggregateError([{ code: "ECONNREFUSED" }, { code: "ETIMEDOUT" }]), { code: "ECONNREFUSED" });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(error));
    expect((await probeOllama()).state).toBe("unresponsive");
  });

  it("recognizes aggregate failures when every connection attempt was refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new AggregateError([{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }])),
    );
    expect((await probeOllama()).state).toBe("absent");
  });

  it("classifies a deadline expiration as unresponsive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(
        (_url, options) =>
          new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
          }),
      ),
    );
    expect(await probeOllama({ timeoutMs: 15 })).toMatchObject({ state: "unresponsive", detail: expect.stringContaining("too long") });
  });

  it("recognizes an HTTP error as an occupied endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("busy", { status: 503 })));
    expect(await probeOllama()).toMatchObject({ state: "unresponsive", detail: expect.stringContaining("503") });
  });

  it.each(["not JSON", JSON.stringify({}), JSON.stringify({ version: "" }), JSON.stringify({ version: 123 })])(
    "does not mistake an invalid version response for absence: %s",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(body)));
      expect((await probeOllama()).state).toBe("unresponsive");
    },
  );

  it("does not mistake a disconnected response body for a refused connection", async () => {
    const response = new Response("unused");
    vi.spyOn(response, "json").mockRejectedValue(new TypeError("disconnected", { cause: { code: "ECONNREFUSED" } }));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
    expect((await probeOllama()).state).toBe("unresponsive");
  });
});
