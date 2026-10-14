import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createNetworkGuard } from "../src/security/network-guard";

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("node:http", async () => ({
  ...(await vi.importActual<typeof import("node:http")>("node:http")),
  request: network.request,
}));

describe("browser HTTP destination pinning", () => {
  it("serves a public GET with Node family autoselection without resolving again", async () => {
    network.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    network.request.mockImplementation((url, options, callback) => {
      expect(url.href).toBe("http://example.com/article");
      options.lookup("example.com", { all: true }, (error, addresses) => {
        expect(error).toBe(null);
        expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
      });
      options.lookup("example.com", {}, (error, address, family) => {
        expect(error).toBe(null);
        expect(address).toBe("93.184.216.34");
        expect(family).toBe(4);
      });
      return Object.assign(new EventEmitter(), {
        end: (): void => {
          const response = Object.assign(new PassThrough(), {
            statusCode: 200,
            headers: { "content-type": "text/html" },
          });
          callback(response);
          response.end("Public article");
        },
        destroy: (): void => {},
      });
    });
    const http = await vi.importActual<typeof import("node:http")>("node:http");
    const guard = await createNetworkGuard();
    try {
      const proxy = new URL(guard.url);
      const result = await new Promise<string>((resolve, reject) => {
        const request = http.request(
          {
            hostname: proxy.hostname,
            port: proxy.port,
            path: "http://example.com/article",
          },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => resolve(body));
            response.on("error", reject);
          },
        );
        request.on("error", reject);
        request.end();
      });
      expect(result).toBe("Public article");
      expect(network.lookup).toHaveBeenCalledTimes(1);
      expect(network.request).toHaveBeenCalledTimes(1);
    } finally {
      await guard.close();
    }
  });
});
