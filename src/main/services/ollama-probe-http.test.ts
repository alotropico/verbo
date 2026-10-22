import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { probeOllama } from "./ollama-probe";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  server = undefined;
});

it("distinguishes a real local listener, HTTP failure, delayed response, and closed port", async () => {
  let mode: "ready" | "error" | "slow" = "ready";
  server = createServer((_request, response) => {
    if (mode === "slow") return;
    response.writeHead(mode === "ready" ? 200 : 503, { "Content-Type": "application/json" });
    response.end(JSON.stringify(mode === "ready" ? { version: "local-fixture" } : { error: "busy" }));
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const options = { baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 500 };
  expect(await probeOllama(options)).toEqual({ state: "ready", version: "local-fixture" });
  mode = "error";
  expect(await probeOllama(options)).toMatchObject({ state: "unresponsive", detail: expect.stringContaining("503") });
  mode = "slow";
  expect(await probeOllama({ ...options, timeoutMs: 30 })).toMatchObject({
    state: "unresponsive",
    detail: expect.stringContaining("too long"),
  });
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  expect(await probeOllama(options)).toEqual({ state: "absent" });
});
