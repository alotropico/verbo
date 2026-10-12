import { Tooltip } from "@mantine/core";
import { useAuiState } from "@assistant-ui/react";
import {
  formatEstimatedTokens,
  meterLevel,
  type ContextMeters as MeterSnapshot,
} from "@shared/memory";
import { isPersistedThreadId } from "@shared/thread-identity";
import { BrainIcon, GaugeIcon } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import styles from "./ContextMeters.module.css";

const EMPTY: MeterSnapshot = {
  memoryTokens: 0,
  memoryBudget: 512,
  contextTokens: 0,
  contextWindow: 8192,
  lastPromptEval: null,
};

function levelClass(used: number, total: number): string {
  const level = meterLevel(used, total);
  if (level === "high") return styles.high;
  if (level === "warn") return styles.warn;
  return styles.ok;
}

export function ContextMeters(): ReactElement {
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const [meters, setMeters] = useState<MeterSnapshot>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void window.verbo.context
        .estimate(isPersistedThreadId(threadId) ? { threadId } : {})
        .then((next) => {
          if (!cancelled) setMeters(next);
        })
        .catch(() => undefined);
    };
    load();
    const onChange = (): void => load();
    window.addEventListener("verbo:memory-changed", onChange);
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.removeEventListener("verbo:memory-changed", onChange);
      window.clearInterval(timer);
    };
  }, [threadId]);

  const memoryPercent =
    meters.memoryBudget > 0
      ? Math.round((meters.memoryTokens / meters.memoryBudget) * 100)
      : 0;
  const contextPercent =
    meters.contextWindow > 0
      ? Math.round((meters.contextTokens / meters.contextWindow) * 100)
      : 0;
  const calibration =
    meters.lastPromptEval === null
      ? "Character estimate, about 4 characters per token."
      : `Character estimate. Last Ollama prompt evaluation was ${meters.lastPromptEval}.`;

  const memoryLabel = `Always-on global memory, ${memoryPercent}% of the budget. Optional memories stay out until retrieved. ${calibration}`;
  const contextLabel = `Estimated input for the next request, ${contextPercent}% of the configured window. Excludes the message being typed. ${calibration}`;

  return (
    <div className={styles.meters}>
      <Tooltip label={memoryLabel} multiline w={240}>
        <span
          aria-label={`Memory ${meters.memoryTokens} / ${meters.memoryBudget}`}
          className={`${styles.meter} ${levelClass(meters.memoryTokens, meters.memoryBudget)}`}
        >
          <BrainIcon aria-hidden="true" className={styles.icon} />
          <span>
            {meters.memoryTokens} / {meters.memoryBudget}
          </span>
        </span>
      </Tooltip>
      <Tooltip label={contextLabel} multiline w={240}>
        <span
          aria-label={`Context ${formatEstimatedTokens(meters.contextTokens)} / ${formatEstimatedTokens(meters.contextWindow)}`}
          className={`${styles.meter} ${levelClass(meters.contextTokens, meters.contextWindow)}`}
        >
          <GaugeIcon aria-hidden="true" className={styles.icon} />
          <span>
            {formatEstimatedTokens(meters.contextTokens)} /{" "}
            {formatEstimatedTokens(meters.contextWindow)}
          </span>
        </span>
      </Tooltip>
    </div>
  );
}
