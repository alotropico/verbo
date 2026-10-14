import {
  browserRequestSchema,
  webSettingsSchema,
} from "../../src/shared/web-contracts";
import {
  browserFrameDecoder,
  encodeBrowserFrame,
} from "../../src/shared/browser-framing";
import { PuppeteerCoreDriver } from "./driver/puppeteer-driver";

const settings = webSettingsSchema.parse(
  JSON.parse(process.env.VERBO_BROWSER_SETTINGS ?? "{}"),
);
let driver: PuppeteerCoreDriver | null = null;
let queue = Promise.resolve();
let closing = false;
let idle: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<string, AbortController>();
const reply = (value: unknown): void => {
  process.stdout.write(encodeBrowserFrame(value));
};
const close = async (): Promise<void> => {
  closing = true;
  clearTimeout(idle);
  for (const controller of pending.values()) controller.abort();
  await queue.catch(() => {});
  await driver?.close();
  driver = null;
};
const decode = browserFrameDecoder((raw) => {
  const request = browserRequestSchema.parse(raw);
  if (request.op === "cancel") {
    pending.get(request.targetId)?.abort();
    return;
  }
  if (request.op === "close") {
    void close().then(() => {
      reply({ id: request.id, ok: true, value: null });
      process.exit(0);
    });
    return;
  }
  if (closing || pending.size >= 16 || pending.has(request.id)) {
    reply({ id: request.id, ok: false, code: "browser_busy" });
    return;
  }
  clearTimeout(idle);
  const controller = new AbortController();
  pending.set(request.id, controller);
  queue = queue.then(async () => {
    const started = Date.now();
    let outcome = "cancelled";
    const timer = setTimeout(
      () => controller.abort("timeout"),
      request.timeoutMs,
    );
    try {
      if (controller.signal.aborted) throw new Error("cancelled");
      driver ??= new PuppeteerCoreDriver(settings);
      const value = await driver.execute(request, controller.signal);
      outcome = "outcome" in value ? value.outcome : "ok";
      reply({ id: request.id, ok: true, value });
    } catch (error) {
      const code = controller.signal.aborted
        ? controller.signal.reason === "timeout"
          ? "timeout"
          : "cancelled"
        : error instanceof Error && /^[a-z_]{1,64}$/.test(error.message)
          ? error.message
          : "browser_failed";
      outcome = code;
      reply({ id: request.id, ok: false, code });
    } finally {
      if (settings.diagnostics)
        process.stderr.write(
          JSON.stringify({
            event: "browser_request",
            op: request.op,
            ...(request.op === "searchEngine"
              ? { engine: request.engine }
              : {}),
            outcome,
            durationMs: Math.min(120000, Date.now() - started),
          }) + "\n",
        );
      clearTimeout(timer);
      pending.delete(request.id);
      if (!pending.size && !closing)
        idle = setTimeout(() => {
          void close().finally(() => process.exit(0));
        }, settings.idleMs);
    }
  });
});
process.stdin.on("data", (chunk: Buffer) => {
  try {
    decode(chunk);
  } catch {
    void close().finally(() => process.exit(1));
  }
});
process.stdin.on("end", () => {
  void close().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});
