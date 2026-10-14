import type { SearchEngineId } from "../../../src/shared/web-contracts";

/** Self-contained so Puppeteer can serialize this trusted DOM readiness check. */
export function searchPageReady(engine: SearchEngineId): boolean {
  const visible = (node: Element): boolean => {
    const style = getComputedStyle(node);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      node.getClientRects().length > 0
    );
  };
  const selectors = {
    google: "div.MjjYud h3, div.g h3, div[data-sokoban-container] h3",
    duckduckgo: ".result .result__title",
    bing: "li.b_algo h2",
  };
  if (
    Array.from(document.querySelectorAll(selectors[engine])).some((heading) => {
      const link = heading.closest("a") ?? heading.querySelector("a");
      return Boolean(
        link?.getAttribute("href") &&
        heading.textContent?.trim() &&
        visible(heading),
      );
    })
  )
    return true;
  const text = document.body?.innerText ?? "";
  if (
    /unusual traffic|automated queries|verify (?:that )?you are human|complete (?:the |this )?captcha|bots use duckduckgo|access denied|before you continue to google|accept all cookies to continue|did not match any documents|no results (?:found|for)|there are no results|no results\./i.test(
      text,
    )
  )
    return true;
  return Array.from(
    document.querySelectorAll(
      "#challenge-form, form[action*='/sorry'], iframe[src*='recaptcha'], input[name='captcha']",
    ),
  ).some(visible);
}
