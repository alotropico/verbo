import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createVoiceBridge, createVoiceClient } from "./client";

const TOKEN = "t".repeat(32);

async function listen(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("voice client", () => {
  it("reports offline without a token and does not fetch", async () => {
    let called = 0;
    const client = createVoiceClient({
      baseUrl: "http://127.0.0.1:8765",
      token: null,
      fetchImpl: async () => {
        called += 1;
        throw new Error("fetched");
      },
    });
    const status = await client.status();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.detail).toMatch(/Typed chat still works/);
    expect(called).toBe(0);
  });

  it("reads health, transcribes, and synthesizes with the bearer token", async () => {
    const seen: string[] = [];
    const server = await listen((request, response) => {
      seen.push(request.headers.authorization ?? "");
      if (request.url === "/v1/health") {
        response.end(
          JSON.stringify({
            identity: "verbo-voice",
            apiVersion: "1",
            stt: { ready: false, detail: "model missing" },
            tts: { ready: false, detail: "piper missing" },
            voices: [],
          }),
        );
        return;
      }
      if (request.url === "/v1/transcribe") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ text: "hello", language: "en" }));
        return;
      }
      response.setHeader("content-type", "audio/wav");
      response.end(Buffer.from("RIFF....WAVE"));
    });
    const client = createVoiceClient({
      baseUrl: server.url,
      token: TOKEN,
    });
    const status = await client.status();
    expect(status.ok).toBe(true);
    if (status.ok) expect(status.stt.detail).toBe("model missing");
    const heard = await client.transcribe(Uint8Array.from([1, 2, 3, 4]));
    expect(heard).toMatchObject({ ok: true, text: "hello" });
    const spoken = await client.synthesize({ text: "Hello" });
    expect(spoken.ok).toBe(true);
    expect(seen.every((header) => header === `Bearer ${TOKEN}`)).toBe(true);
    await server.close();
  });

  it("sends a forced recognition language with the audio", async () => {
    let body = "";
    const server = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        body = Buffer.concat(chunks).toString("utf8");
        response.end(JSON.stringify({ text: "hola", language: "es" }));
      });
    });
    const client = createVoiceClient({
      baseUrl: server.url,
      token: TOKEN,
    });
    const heard = await client.transcribe(Uint8Array.from([1, 2, 3, 4]), {
      language: "es",
    });
    expect(heard).toMatchObject({ ok: true, text: "hola", language: "es" });
    expect(body).toContain('name="language"');
    expect(body).toContain("es");
    await server.close();
  });

  it("cancels the active request from the bridge", async () => {
    const server = await listen(() => {
      // Leave the socket open until the client aborts.
    });
    const bridge = createVoiceBridge(
      createVoiceClient({ baseUrl: server.url, token: TOKEN }),
    );
    const pending = bridge.transcribe(Uint8Array.from([1, 2, 3, 4]));
    bridge.cancel();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: "cancelled" });
    await server.close();
  });

  it("does not cancel transcription when synthesis starts", async () => {
    let transcribeAborted = false;
    const server = await listen((request, response) => {
      if (request.url === "/v1/synthesize") {
        response.setHeader("content-type", "audio/wav");
        response.end(Buffer.from("RIFF....WAVE"));
        return;
      }
      response.on("close", () => {
        if (!response.writableEnded) transcribeAborted = true;
      });
    });
    const bridge = createVoiceBridge(
      createVoiceClient({ baseUrl: server.url, token: TOKEN }),
    );
    const pending = bridge.transcribe(Uint8Array.from([1, 2, 3, 4]));
    const spoken = await bridge.synthesize({ text: "Hello" });
    expect(spoken.ok).toBe(true);
    expect(transcribeAborted).toBe(false);
    bridge.cancel();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "cancelled",
    });
    await server.close();
  });
});
