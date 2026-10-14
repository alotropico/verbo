import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_WEB_SETTINGS } from "../../shared/web-contracts";
import { StdioBrowserClient } from "./browser-client";

const clients: StdioBrowserClient[] = [];
function client(): StdioBrowserClient {
  const value = new StdioBrowserClient(
    { ...DEFAULT_WEB_SETTINGS, engineTimeoutMs: 50 },
    join(__dirname, "__fixtures__/browser-worker.mjs"),
  );
  clients.push(value);
  return value;
}
const signal = (): AbortSignal => new AbortController().signal;
afterEach(async () => {
  await Promise.all(clients.splice(0).map((value) => value.close()));
});
describe("isolated browser transport", () => {
  it.runIf(process.platform === "win32")(
    "reaps descendants when the worker crashes",
    async () => {
      const browser = client();
      const result = await browser.searchEngine(
        "google",
        "descendant",
        1,
        signal(),
      );
      const descendant = Number(result.results[0].title);
      try {
        expect(() => process.kill(descendant, 0)).not.toThrow();
        await expect(
          browser.searchEngine("google", "crash", 1, signal()),
        ).rejects.toThrow("browser_crashed");
        let alive = true;
        for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
          try {
            process.kill(descendant, 0);
            await new Promise((resolve) => setTimeout(resolve, 25));
          } catch {
            alive = false;
          }
        }
        expect(alive).toBe(false);
      } finally {
        try {
          process.kill(descendant);
        } catch {
          /* Already reaped by the job. */
        }
      }
    },
  );
  it("starts lazily, reuses one worker and closes it without leaving a process", async () => {
    const browser = client();
    await browser.close(); // No worker was needed.
    const first = await browser.searchEngine("google", "ok", 1, signal());
    const second = await browser.searchEngine("bing", "ok", 1, signal());
    expect(second.results[0].title).toBe(first.results[0].title);
    await browser.close();
    expect(() => process.kill(Number(first.results[0].title), 0)).toThrow();
  });
  it.each(["crash", "protocol"])(
    "returns a typed %s failure and permits a subsequent fresh worker",
    async (query) => {
      const browser = client();
      await expect(
        browser.searchEngine("google", query, 1, signal()),
      ).rejects.toThrow(
        query === "crash" ? "browser_crashed" : "browser_protocol",
      );
      expect(
        (await browser.searchEngine("bing", "ok", 1, signal())).outcome,
      ).toBe("ok");
    },
  );
  it("cancels one correlated request without contaminating another result", async () => {
    const browser = client();
    const controller = new AbortController();
    const pending = browser.searchEngine(
      "google",
      "slow",
      1,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(
      (await browser.searchEngine("bing", "ok", 1, signal())).results[0].engine,
    ).toBe("bing");
  });
  it("bounds a silent worker and safely closes with a request pending", async () => {
    const browser = client();
    await expect(
      browser.searchEngine("google", "hang", 1, signal()),
    ).rejects.toThrow("timeout");
    const pending = browser.searchEngine("google", "hang", 1, signal());
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await browser.close();
    await rejected;
  });
});
