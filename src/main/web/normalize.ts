import { publicUrl } from "../../shared/public-network";
import { allowedEngines, type EngineId, type OrganicResult } from "../../shared/web";

const TRACKING_PARAM_REGEX = /^(utm_.*|gclid|fbclid)$/i;
const MAX_URL_LENGTH = 4096;
const MAX_TITLE_CODEPOINTS = 180;

function truncateCodePoints(text: string, maxCodePoints: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= maxCodePoints) return text;
  return codePoints.slice(0, maxCodePoints).join("");
}

export function normalizeUrl(rawUrl: string): string | null {
  if (typeof rawUrl !== "string" || !rawUrl || rawUrl.length > MAX_URL_LENGTH) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = publicUrl(rawUrl);
  } catch {
    return null;
  }

  // Remove fragment
  parsed.hash = "";

  // Filter tracking parameters
  const params = new URLSearchParams(parsed.search);
  const remainingParams: [string, string][] = [];
  for (const [key, value] of params.entries()) {
    if (!TRACKING_PARAM_REGEX.test(key)) {
      remainingParams.push([key, value]);
    }
  }

  // Sort remaining parameters
  remainingParams.sort(([keyA, valA], [keyB, valB]) => {
    const keyComp = keyA.localeCompare(keyB);
    if (keyComp !== 0) return keyComp;
    return valA.localeCompare(valB);
  });

  const sortedSearchParams = new URLSearchParams();
  for (const [k, v] of remainingParams) {
    sortedSearchParams.append(k, v);
  }

  parsed.search = sortedSearchParams.toString();
  return parsed.href;
}

export function normalizeOrganicResults(rawRows: unknown[], maxSnippetChars: number): OrganicResult[] {
  if (!Array.isArray(rawRows)) return [];

  const seenUrls = new Set<string>();
  const normalized: OrganicResult[] = [];

  for (const row of rawRows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;

    const rawTitle = typeof item.title === "string" ? item.title : null;
    const rawUrl = typeof item.url === "string" ? item.url : null;
    const rawSnippet = typeof item.snippet === "string" ? item.snippet : "";
    const rawEngine = item.engine as EngineId;

    if (!rawTitle || !rawUrl || !allowedEngines.includes(rawEngine)) {
      continue;
    }

    const cleanUrl = normalizeUrl(rawUrl);
    if (!cleanUrl || seenUrls.has(cleanUrl)) {
      continue;
    }

    const titleCollapsed = rawTitle.trim().replace(/\s+/g, " ");
    if (!titleCollapsed) {
      continue;
    }
    const titleTruncated = truncateCodePoints(titleCollapsed, MAX_TITLE_CODEPOINTS);

    const snippetCollapsed = rawSnippet.trim().replace(/\s+/g, " ");
    const snippetTruncated = truncateCodePoints(snippetCollapsed, maxSnippetChars);

    seenUrls.add(cleanUrl);
    normalized.push({
      title: titleTruncated,
      url: cleanUrl,
      snippet: snippetTruncated,
      engine: rawEngine,
    });
  }

  return normalized;
}
