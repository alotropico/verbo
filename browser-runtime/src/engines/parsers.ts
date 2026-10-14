import { parseHTML } from "linkedom";
import { publicUrl } from "../../../src/shared/public-network";
import type {
  SearchEngineId,
  EngineResult,
  WebSearchResult,
} from "../../../src/shared/web-contracts";

const origins: Record<SearchEngineId, string> = {
  google: "https://www.google.com",
  duckduckgo: "https://html.duckduckgo.com",
  bing: "https://www.bing.com",
};
function engineDomain(hostname: string, engine: SearchEngineId): boolean {
  const domain = engine === "duckduckgo" ? "duckduckgo.com" : `${engine}.com`;
  return hostname === domain || hostname.endsWith(`.${domain}`);
}
export function engineUrl(engine: SearchEngineId, query: string): string {
  const url = new URL(
    engine === "google"
      ? "/search"
      : engine === "duckduckgo"
        ? "/html/"
        : "/search",
    origins[engine],
  );
  url.searchParams.set("q", query);
  if (engine === "google") url.searchParams.set("num", "10");
  return url.href;
}
export function normalizeDestination(
  value: string,
  engine: SearchEngineId,
): string | null {
  try {
    let url = new URL(value, origins[engine]);
    if (
      engine === "google" &&
      engineDomain(url.hostname, "google") &&
      url.pathname === "/url"
    )
      url = new URL(
        url.searchParams.get("q") ?? url.searchParams.get("url") ?? "",
      );
    if (
      engine === "duckduckgo" &&
      engineDomain(url.hostname, "duckduckgo") &&
      url.searchParams.has("uddg")
    )
      url = new URL(url.searchParams.get("uddg")!);
    if (
      engine === "bing" &&
      engineDomain(url.hostname, "bing") &&
      url.pathname.startsWith("/ck/")
    ) {
      const encoded = url.searchParams.get("u") ?? "";
      if (!encoded.startsWith("a1")) return null;
      url = new URL(
        Buffer.from(encoded.slice(2), "base64url").toString("utf8"),
      );
    }
    publicUrl(url.href);
    if (
      /^(www\.)?(google\.com|bing\.com|duckduckgo\.com)$/.test(url.hostname) ||
      url.hostname.endsWith(".duckduckgo.com")
    )
      return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()])
      if (/^(utm_|gclid|fbclid)/i.test(key)) url.searchParams.delete(key);
    return url.href.length <= 2048 ? url.href : null;
  } catch {
    return null;
  }
}
export function parseSearchPage(
  engine: SearchEngineId,
  html: string,
  limit: number,
  status = 200,
  visibleText?: string,
): EngineResult {
  if (html.length > 2 * 1024 * 1024)
    return { outcome: "parse_error", code: "page_too_large", results: [] };
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll(
    "script, style, template, [hidden], [aria-hidden='true']",
  ))
    node.remove();
  const text =
    visibleText ??
    document.body?.textContent ??
    document.documentElement.textContent ??
    "";
  if (
    [403, 429].includes(status) ||
    /unusual traffic|automated queries|verify (?:that )?you are human|complete (?:the |this )?captcha|bots use duckduckgo|access denied/i.test(
      text,
    ) ||
    document.querySelector(
      'form[action*="/sorry"], #challenge-form, iframe[src*="recaptcha"], input[name="captcha"]',
    )
  )
    return { outcome: "blocked", code: "engine_blocked", results: [] };
  if (status >= 400)
    return { outcome: "network_error", code: `http_${status}`, results: [] };
  if (
    /before you continue to google|consent\.google\.com|accept all cookies to continue/i.test(
      text,
    )
  )
    return { outcome: "blocked", code: "consent_required", results: [] };
  const selectors: Record<SearchEngineId, string> = {
    google: "div.MjjYud, div.g, div[data-sokoban-container]",
    duckduckgo: ".result",
    bing: "li.b_algo",
  };
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  let rank = 0;
  for (const entry of document.querySelectorAll(selectors[engine])) {
    if (
      entry.closest("#tads, #bottomads, .b_ad, .result--ad, [data-text-ad]") ||
      entry.querySelector(
        '[data-text-ad], .b_ad, .result__badge, [aria-label="Ads"]',
      ) ||
      /^(Sponsored|Ad)\s/.test(entry.textContent?.trim() ?? "")
    )
      continue;
    const heading = entry.querySelector(
      engine === "google" ? "h3" : engine === "bing" ? "h2" : ".result__title",
    );
    const link = heading?.closest("a") ?? heading?.querySelector("a");
    if (!link) continue;
    const url = normalizeDestination(link.getAttribute("href") ?? "", engine);
    const title = heading?.textContent
      ?.replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
    if (!url || !title || seen.has(url)) continue;
    rank += 1;
    seen.add(url);
    const snippet = entry
      .querySelector(
        engine === "google"
          ? ".VwiC3b, .IsZvec"
          : engine === "bing"
            ? ".b_caption p"
            : ".result__snippet",
      )
      ?.textContent?.replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    results.push({ title, url, ...(snippet ? { snippet } : {}), engine, rank });
    if (results.length >= Math.min(10, limit)) break;
  }
  if (results.length) return { outcome: "ok", results };
  if (
    /did not match any documents|no results (?:found|for)|there are no results|no results\./i.test(
      text,
    )
  )
    return { outcome: "no_results", code: "no_results", results: [] };
  return {
    outcome: "parse_error",
    code: "organic_results_missing",
    results: [],
  };
}
