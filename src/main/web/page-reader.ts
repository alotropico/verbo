import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import { resolvePublicUrl } from "../../shared/public-network";
import { extractReadablePage } from "../../shared/readable-page";
import type { BrowserClient, WebSettings } from "../../shared/web-contracts";
import type { ActionResult } from "../../shared/action-contract";
import { webSourceId } from "./source-reference";

function boundedPageData(
  page: { title?: string; text: string; truncated: boolean; finalUrl: string },
  method: "http" | "browser",
): NonNullable<ActionResult["data"]> {
  const data = {
    title: page.title ?? "",
    text: page.text,
    truncated: page.truncated,
    finalUrl: page.finalUrl,
    method,
    untrusted: true,
    sourceId: webSourceId(page.finalUrl),
  };
  while (JSON.stringify(data).length > 14000 && data.text.length) {
    data.text = data.text.slice(0, Math.floor(data.text.length * 0.8));
    data.truncated = true;
  }
  return data;
}

export async function retrievePublicHtml(
  value: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<{ html: string; finalUrl: string }> {
  if (redirects > 5) throw new Error("redirect_limit");
  signal.throwIfAborted();
  const destination = await resolvePublicUrl(value, undefined, signal);
  signal.throwIfAborted();
  const response = await new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => {
      const request = (
        destination.url.protocol === "https:" ? httpsRequest : httpRequest
      )(
        destination.url,
        {
          signal,
          headers: {
            accept: "text/html,application/xhtml+xml",
            "accept-encoding": "gzip, br, deflate",
            "user-agent": "Verbo public page reader",
          },
          lookup: (_hostname, options, callback) => {
            // Node's family autoselection asks for all addresses. Keep the
            // pinned destination in either callback shape; never resolve again.
            if (options.all)
              callback(null, [
                { address: destination.address, family: destination.family },
              ]);
            else callback(null, destination.address, destination.family);
          },
          timeout: 15000,
        },
        resolve,
      );
      request.on("error", reject);
      request.on("timeout", () => request.destroy(new Error("timeout")));
      request.end();
    },
  );
  if (
    [301, 302, 303, 307, 308].includes(response.statusCode ?? 0) &&
    response.headers.location
  ) {
    response.destroy();
    return retrievePublicHtml(
      new URL(response.headers.location, destination.url).href,
      signal,
      redirects + 1,
    );
  }
  if ((response.statusCode ?? 0) >= 400) {
    response.destroy();
    throw new Error("page_blocked");
  }
  if (
    !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
      response.headers["content-type"] ?? "",
    )
  ) {
    response.destroy();
    throw new Error("content_type");
  }
  if (Number(response.headers["content-length"] ?? 0) > 1024 * 1024) {
    response.destroy();
    throw new Error("page_too_large");
  }
  let compressed = 0;
  response.on("data", (chunk: Buffer) => {
    compressed += chunk.length;
    if (compressed > 1024 * 1024) response.destroy(new Error("page_too_large"));
  });
  const encoding = response.headers["content-encoding"];
  if (encoding && !["gzip", "br", "deflate", "identity"].includes(encoding)) {
    response.destroy();
    throw new Error("content_encoding");
  }
  const decompressor =
    encoding === "gzip"
      ? createGunzip()
      : encoding === "br"
        ? createBrotliDecompress()
        : encoding === "deflate"
          ? createInflate()
          : null;
  const stream: Readable = decompressor
    ? response.pipe(decompressor)
    : response;
  if (decompressor)
    response.on("error", (error) => decompressor.destroy(error));
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 2 * 1024 * 1024) throw new Error("page_too_large");
      chunks.push(bytes);
    }
    return {
      html: Buffer.concat(chunks).toString("utf8"),
      finalUrl: destination.url.href,
    };
  } finally {
    response.destroy();
    decompressor?.destroy();
  }
}
export async function readPublicPage(input: {
  url: string;
  maxChars: number;
  method: "auto" | "http" | "browser";
  settings: WebSettings;
  browser: BrowserClient;
  signal?: AbortSignal;
  retrieve?: typeof retrievePublicHtml;
}): Promise<ActionResult> {
  const timeout = AbortSignal.timeout(input.settings.searchTimeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  const maxChars = Math.min(input.maxChars, input.settings.maxChars);
  try {
    // Validate even the rendered-only path before handing it to the worker.
    await resolvePublicUrl(input.url, undefined, signal);
    if (input.method !== "browser") {
      const page = await (input.retrieve ?? retrievePublicHtml)(
        input.url,
        signal,
      );
      const extracted = extractReadablePage(page.html, maxChars);
      if (
        extracted.text &&
        (!extracted.needsRendering || input.method === "http")
      )
        return {
          action: "web.read",
          status: "success",
          summary: `Read ${extracted.title || "page"}.`,
          data: boundedPageData(
            { ...extracted, finalUrl: page.finalUrl },
            "http",
          ),
        };
      if (input.method === "http") throw new Error("empty_page");
    }
    const page = await input.browser.readRenderedPage(
      input.url,
      maxChars,
      signal,
    );
    await resolvePublicUrl(page.finalUrl, undefined, signal);
    return {
      action: "web.read",
      status: "success",
      summary: `Read ${page.title || "page"}.`,
      data: boundedPageData(page, "browser"),
    };
  } catch (error) {
    const cancelled = input.signal?.aborted;
    const code = cancelled
      ? "cancelled"
      : signal.aborted
        ? "timeout"
        : error instanceof Error && /^[a-z_]{1,64}$/.test(error.message)
          ? error.message
          : "read_failed";
    return {
      action: "web.read",
      status: cancelled ? "cancelled" : "error",
      code,
      summary: cancelled
        ? "Page reading cancelled."
        : `Page reading failed (${code}).`,
    };
  }
}
