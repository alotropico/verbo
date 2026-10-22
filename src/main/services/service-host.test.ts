import { expect, it, vi } from "vitest";
import { serviceManager } from "./service-host";

it("shares one service manager while its asynchronous initialization is still pending", async () => {
  const first = serviceManager("C:/verbo-nonexistent-fixture");
  const second = serviceManager("C:/verbo-nonexistent-fixture");
  expect(first).toBe(second);
  const [one, two] = await Promise.all([first, second]);
  expect(one).toBe(two);
  expect(one.snapshot().ollama.state).toBe("stopped");
  await one.shutdown();
});

it("does not acquire a voice service when disabled for the hidden instance", async () => {
  vi.resetModules();
  const { serviceManager: isolatedManager } = await import("./service-host");
  const manager = await isolatedManager("C:/verbo-nonexistent-fixture", { voiceEnabled: false });
  const voice = await manager.ensureVoice();
  expect(voice).toMatchObject({ state: "error", owned: false, pid: null });
  expect(voice.detail).toContain("Voice is disabled");
  await manager.shutdown();
});

it("does not acquire a web service when disabled for the hidden instance", async () => {
  vi.resetModules();
  const { serviceManager: isolatedManager } = await import("./service-host");
  const manager = await isolatedManager("C:/verbo-nonexistent-fixture", { webEnabled: false });
  expect(manager.snapshot().web.state).toBe("stopped");
  const web = await manager.ensureWeb();
  expect(web).toMatchObject({ state: "error", owned: false, pid: null });
  expect(web.detail).toContain("Web search is disabled");
  await manager.shutdown();
});
