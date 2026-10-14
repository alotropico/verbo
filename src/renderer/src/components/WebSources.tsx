import { useAuiState } from "@assistant-ui/react";
import type { ReactElement } from "react";
import {
  webSourcesFromResult,
  type WebSourceReference,
} from "@shared/web-sources";
import styles from "./WebSources.module.css";

export function WebSources(): ReactElement | null {
  const parts = useAuiState((state) => state.message.content);
  const sources = new Map<string, WebSourceReference>();
  for (const part of parts)
    if (part.type === "tool-call" && part.result !== undefined)
      for (const source of webSourcesFromResult(part.result))
        sources.set(source.sourceId, source);
  if (!sources.size) return null;
  return (
    <ul className={styles.sources} aria-label="Web sources">
      {[...sources.values()].map((source) => (
        <li key={source.sourceId}>
          <a href={source.url} target="_blank" rel="noreferrer">
            {source.title || source.url}
          </a>
          <span>{source.kind === "page" ? "Read page" : "Search lead"}</span>
        </li>
      ))}
    </ul>
  );
}
