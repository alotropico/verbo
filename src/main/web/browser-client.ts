import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ownBrowserProcessTree } from "../platform/process-tree";
import {
  browserFrameDecoder,
  encodeBrowserFrame,
} from "../../shared/browser-framing";
import {
  browserResponseSchema,
  browserDiagnosticSchema,
  searchEngineResultSchema,
  renderedPageSchema,
  type BrowserClient,
  type BrowserRequest,
  type WebSettings,
} from "../../shared/web-contracts";

export class StdioBrowserClient implements BrowserClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private idle: ReturnType<typeof setTimeout> | undefined;
  private shutdown: Promise<void> | null = null;
  private releaseTree: (() => void) | null = null;
  constructor(
    private settings: WebSettings,
    private workerPath = join(__dirname, "browser-runtime.js"),
    private executable = process.execPath,
  ) {}
  private start(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const child = spawn(this.executable, [this.workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: {
        ...Object.fromEntries(
          [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "LOCALAPPDATA",
            "ProgramFiles",
            "ProgramFiles(x86)",
          ].flatMap((key) =>
            process.env[key] ? [[key, process.env[key]!]] : [],
          ),
        ),
        ELECTRON_RUN_AS_NODE: "1",
        VERBO_BROWSER_SETTINGS: JSON.stringify(this.settings),
      },
    });
    try {
      // Assign ownership before sending the first request: the worker cannot
      // launch Chromium before that request, so descendants inherit the job.
      this.releaseTree = child.pid ? ownBrowserProcessTree(child.pid) : null;
    } catch {
      child.kill();
      throw new Error("browser_isolation_unavailable");
    }
    this.child = child;
    const fail = (code: string): void => {
      if (this.child !== child) return;
      this.child = null;
      this.releaseTree?.();
      this.releaseTree = null;
      for (const request of this.pending.values())
        request.reject(new Error(code));
      this.pending.clear();
      child.kill();
    };
    const decode = browserFrameDecoder((raw) => {
      const response = browserResponseSchema.parse(raw);
      const request = this.pending.get(response.id);
      if (!request) return; // Cancelled request's late reply is never reused.
      this.pending.delete(response.id);
      if (response.ok) request.resolve(response.value);
      else request.reject(new Error(response.code));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        decode(chunk);
      } catch {
        fail("browser_protocol");
      }
    });
    let diagnosticBuffer = "";
    let diagnosticCount = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (!this.settings.diagnostics || diagnosticCount >= 16) return;
      diagnosticBuffer = (diagnosticBuffer + chunk.toString("utf8")).slice(
        -2048,
      );
      const lines = diagnosticBuffer.split("\n");
      diagnosticBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (diagnosticCount >= 16) break;
        try {
          const diagnostic = browserDiagnosticSchema.safeParse(
            JSON.parse(line),
          );
          if (diagnostic.success) {
            diagnosticCount += 1;
            console.info("[Verbo browser]", diagnostic.data);
          }
        } catch {
          /* Raw browser diagnostics are discarded. */
        }
      }
    });
    child.stdin.on("error", () => fail("browser_crashed"));
    child.stdout.on("error", () => fail("browser_protocol"));
    child.on("error", () => fail("browser_unavailable"));
    child.on("exit", () => fail("browser_crashed"));
    return child;
  }
  private request(
    request: BrowserRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) return Promise.reject(new Error("cancelled"));
    if (this.shutdown) return Promise.reject(new Error("browser_closing"));
    if (this.pending.size >= 16)
      return Promise.reject(new Error("browser_busy"));
    clearTimeout(this.idle);
    const child = this.start();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        this.pending.delete(request.id);
        if (!this.pending.size && this.child === child)
          this.idle = setTimeout(() => {
            void this.close();
          }, this.settings.idleMs);
        if (error) reject(error);
        else resolve(value);
      };
      const cancel = (): void => {
        child.stdin.write(
          encodeBrowserFrame({
            id: randomUUID(),
            op: "cancel",
            targetId: request.id,
          }),
          () => {},
        );
        finish(new Error(signal.aborted ? "cancelled" : "timeout"));
      };
      const timer = setTimeout(
        cancel,
        "timeoutMs" in request ? request.timeoutMs + 1000 : 5000,
      );
      this.pending.set(request.id, {
        resolve: (value) => finish(undefined, value),
        reject: (error) => finish(error),
      });
      signal.addEventListener("abort", cancel, { once: true });
      child.stdin.write(encodeBrowserFrame(request), (error) => {
        if (error) finish(new Error("browser_crashed"));
      });
      if (signal.aborted) cancel();
    });
  }
  async searchEngine(
    engine: Parameters<BrowserClient["searchEngine"]>[0],
    query: string,
    limit: number,
    signal: AbortSignal,
  ): ReturnType<BrowserClient["searchEngine"]> {
    return searchEngineResultSchema.parse(
      await this.request(
        {
          id: randomUUID(),
          op: "searchEngine",
          engine,
          query,
          limit,
          timeoutMs: this.settings.engineTimeoutMs,
        },
        signal,
      ),
    );
  }
  async readRenderedPage(
    url: string,
    maxChars: number,
    signal: AbortSignal,
  ): ReturnType<BrowserClient["readRenderedPage"]> {
    return renderedPageSchema.parse(
      await this.request(
        {
          id: randomUUID(),
          op: "readRenderedPage",
          url,
          maxChars,
          timeoutMs: this.settings.searchTimeoutMs,
        },
        signal,
      ),
    );
  }
  async close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.shutdown = this.stop();
    try {
      await this.shutdown;
    } finally {
      this.shutdown = null;
    }
  }
  private async stop(): Promise<void> {
    clearTimeout(this.idle);
    const child = this.child;
    const releaseTree = this.releaseTree;
    this.releaseTree = null;
    this.child = null;
    for (const request of this.pending.values())
      request.reject(new Error("cancelled"));
    this.pending.clear();
    if (!child || child.exitCode !== null) {
      releaseTree?.();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        releaseTree?.();
        resolve();
      }, 5000);
      child.once("exit", () => {
        releaseTree?.();
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end(
        encodeBrowserFrame({ id: randomUUID(), op: "close" }),
        () => {},
      );
    });
  }
}

let current: { key: string; client: StdioBrowserClient } | null = null;
export async function configuredBrowser(
  settings: WebSettings,
): Promise<BrowserClient> {
  const key = JSON.stringify(settings);
  if (current?.key !== key) {
    await current?.client.close();
    current = { key, client: new StdioBrowserClient(settings) };
  }
  return current.client;
}
export async function closeWebBrowser(): Promise<void> {
  const previous = current;
  current = null;
  await previous?.client.close();
}
