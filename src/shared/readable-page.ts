import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

export function extractReadablePage(
  html: string,
  maxChars: number,
): {
  title: string;
  text: string;
  truncated: boolean;
  needsRendering: boolean;
} {
  if (html.length > 2 * 1024 * 1024) throw new Error("page_too_large");
  const { document } = parseHTML(html);
  const title = (document.querySelector("title")?.textContent ?? "")
    .trim()
    .slice(0, 300);
  const scriptCount = document.querySelectorAll("script").length;
  for (const element of document.querySelectorAll(
    "script, style, nav, footer, header, noscript, iframe, form",
  ))
    element.remove();
  let text = "";
  try {
    text =
      new Readability(document.cloneNode(true) as Document, {
        charThreshold: 80,
        maxElemsToParse: 10000,
        disableJSONLD: true,
      }).parse()?.textContent ?? "";
  } catch {
    /* A plain main/article fallback also serves small public pages. */
  }
  text ||=
    document.querySelector("main, article")?.textContent ??
    document.body?.textContent ??
    "";
  text = text.replace(/\s+/g, " ").trim();
  return {
    title,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
    needsRendering: scriptCount > 0 && text.length < 80,
  };
}
