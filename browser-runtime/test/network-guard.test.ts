import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { createNetworkGuard } from "../src/security/network-guard";

describe("browser public-network guard", () => {
  it("rejects private HTTP destinations, unsafe protocols, writes and private CONNECT tunnels", async () => {
    const guard = await createNetworkGuard();
    try {
      const proxy = new URL(guard.url);
      const status = (path: string, method = "GET"): Promise<number> =>
        new Promise((resolve, reject) => {
          const outgoing = request(
            {
              hostname: proxy.hostname,
              port: proxy.port,
              path,
              method,
              timeout: 1500,
            },
            (response) => {
              response.resume();
              resolve(response.statusCode ?? 0);
            },
          );
          outgoing.once("connect", (response, socket) => {
            socket.destroy();
            resolve(response.statusCode ?? 0);
          });
          outgoing.on("error", reject);
          outgoing.on("timeout", () =>
            outgoing.destroy(new Error("guard test timed out")),
          );
          outgoing.end();
        });
      for (const url of [
        "http://127.0.0.1/",
        "http://2130706433/",
        "http://[::1]/",
        "http://169.254.169.254/",
        "http://192.168.1.1/",
        "file:///C:/Windows/system.ini",
      ])
        expect(await status(url)).toBe(403);
      expect(await status("http://example.com/", "POST")).toBe(403);
      expect(await status("127.0.0.1:443", "CONNECT")).toBe(403);
    } finally {
      await guard.close();
    }
  });
});
