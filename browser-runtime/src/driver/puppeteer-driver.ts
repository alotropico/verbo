import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { browserExecutable } from "../../../src/shared/browser-executable";
import { publicUrl } from "../../../src/shared/public-network";
import type {
  WebSettings,
  BrowserRequest,
  EngineResult,
  RenderedPage,
} from "../../../src/shared/web-contracts";
import { extractReadablePage } from "../../../src/shared/readable-page";
import { engineUrl, parseSearchPage } from "../engines/parsers";
import { searchPageReady } from "../engines/readiness";
import { createNetworkGuard } from "../security/network-guard";

export class PuppeteerCoreDriver {
  private browser: Browser | null = null;
  private profile: string | null = null;
  private profileRoot: string | null = null;
  private guard: Awaited<ReturnType<typeof createNetworkGuard>> | null = null;
  private executable: string;
  private executableIdentity: string;
  constructor(settings: WebSettings) {
    this.executable = browserExecutable(settings.executable);
    this.executableIdentity = this.identity();
  }
  private identity(): string {
    const stat = statSync(this.executable);
    return `${realpathSync(this.executable)}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  }
  private async start(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    await this.close();
    if (this.identity() !== this.executableIdentity)
      throw new Error("browser_changed");
    this.guard = await createNetworkGuard();
    this.profileRoot = realpathSync(tmpdir());
    this.profile = mkdtempSync(join(this.profileRoot, "verbo-browser-"));
    try {
      this.browser = await puppeteer.launch({
        executablePath: this.executable,
        browser: "chrome",
        headless: true,
        pipe: true,
        userDataDir: this.profile,
        ignoreDefaultArgs: ["--disable-popup-blocking"],
        timeout: 10000,
        args: [
          `--proxy-server=${this.guard.url}`,
          "--proxy-bypass-list=<-loopback>",
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--disable-background-networking",
        ],
        env: Object.fromEntries(
          ["SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap((key) =>
            process.env[key] ? [[key, process.env[key]!]] : [],
          ),
        ),
      });
      return this.browser;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async execute(
    request: Extract<
      BrowserRequest,
      { op: "searchEngine" | "readRenderedPage" }
    >,
    signal: AbortSignal,
  ): Promise<EngineResult | RenderedPage> {
    if (signal.aborted) throw new Error("cancelled");
    const browser = await this.start();
    if (signal.aborted) throw new Error("cancelled");
    const context = await browser.createBrowserContext();
    const stop = (): void => {
      void context.close().catch(() => {});
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      const page = await context.newPage();
      await this.prepare(page);
      page.setDefaultNavigationTimeout(request.timeoutMs);
      const url =
        request.op === "searchEngine"
          ? engineUrl(request.engine, request.query)
          : publicUrl(request.url).href;
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: request.timeoutMs,
      });
      if (signal.aborted) throw new Error("cancelled");
      // Short DOM readiness, never an unbounded network-idle wait.
      if (request.op === "searchEngine")
        await page
          .waitForFunction(
            searchPageReady,
            { timeout: Math.min(3000, request.timeoutMs) },
            request.engine,
          )
          .catch(() => {});
      else
        await page
          .waitForFunction(() => (document.body?.innerText?.length ?? 0) > 80, {
            timeout: Math.min(2000, request.timeoutMs),
          })
          .catch(() => {});
      const html = await page.evaluate(() =>
        document.documentElement.outerHTML.slice(0, 2 * 1024 * 1024 + 1),
      );
      if (request.op === "searchEngine") {
        const result = parseSearchPage(
          request.engine,
          html,
          request.limit,
          response?.status(),
          await page.evaluate(
            () => document.body?.innerText?.slice(0, 128 * 1024) ?? "",
          ),
        );
        if (result.outcome !== "ok" && result.outcome !== "no_results")
          return result;
        const displayedQuery = await page.evaluate(() => {
          const input = document.querySelector<HTMLInputElement>(
            'input[name="q"], textarea[name="q"], #sb_form_q',
          );
          return input?.value ?? null;
        });
        const normalize = (text: string): string =>
          text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
        const actualQuery = new URL(page.url()).searchParams.get("q");
        if (
          !actualQuery ||
          normalize(actualQuery) !== normalize(request.query) ||
          (displayedQuery !== null &&
            normalize(displayedQuery) !== normalize(request.query))
        ) {
          return {
            outcome: "parse_error",
            code: "search_query_mismatch",
            results: [],
          };
        }
        return result;
      }
      if ((response?.status() ?? 0) >= 400) throw new Error("page_blocked");
      const extracted = extractReadablePage(html, request.maxChars);
      if (!extracted.text) throw new Error("empty_page");
      if (
        extracted.needsRendering ||
        /^(?:loading|downloading|please wait)[\s.!…]/i.test(extracted.text)
      )
        throw new Error("page_content_unavailable");
      return {
        title: extracted.title,
        finalUrl: publicUrl(page.url()).href,
        text: extracted.text,
        truncated: extracted.truncated,
      };
    } finally {
      signal.removeEventListener("abort", stop);
      await context.close().catch(() => {});
    }
  }
  private async prepare(page: Page): Promise<void> {
    await page.evaluateOnNewDocument(() => {
      // Only built-in read routines are available. Stop background channels
      // whose requests do not consistently pass page request interception.
      const denied = function (): never {
        throw new Error("Background browser operation is disabled.");
      };
      for (const name of [
        "open",
        "Worker",
        "SharedWorker",
        "WebSocket",
        "WebTransport",
      ]) {
        Object.defineProperty(window, name, {
          value: denied,
          configurable: false,
          writable: false,
        });
      }
      if (navigator.serviceWorker)
        Object.defineProperty(
          Object.getPrototypeOf(navigator.serviceWorker),
          "register",
          { value: denied, configurable: false, writable: false },
        );
    });
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      try {
        publicUrl(request.url());
        if (
          !["GET", "HEAD"].includes(request.method()) ||
          ["image", "media", "font", "websocket", "eventsource"].includes(
            request.resourceType(),
          ) ||
          /google-analytics|doubleclick|\/analytics/i.test(request.url())
        )
          throw new Error("blocked_request");
        void request.continue().catch(() => {});
      } catch {
        void request.abort("blockedbyclient").catch(() => {});
      }
    });
    page.on("popup", (popup) => {
      void popup?.close().catch(() => {});
    });
    page.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => {});
    });
    const cdp = await page.createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", {
      behavior: "deny",
      browserContextId: page.browserContext().id,
    });
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
  }
  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => {
      browser.process()?.kill();
    });
    await this.guard?.close();
    this.guard = null;
    if (this.profile) {
      const profile = this.profile;
      this.profile = null;
      const root = this.profileRoot;
      this.profileRoot = null;
      const resolved = realpathSync(profile);
      const child = root ? relative(root, resolved) : "";
      // Check the resolved target before any recursive deletion on Windows.
      if (
        !child ||
        isAbsolute(child) ||
        child.startsWith("..") ||
        !/^verbo-browser-[^\\/]+$/.test(child)
      )
        throw new Error("unsafe_profile_cleanup");
      rmSync(resolved, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  }
}
