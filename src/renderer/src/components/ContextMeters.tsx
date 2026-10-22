import { Tooltip } from "@mantine/core";
import { useAuiState } from "@assistant-ui/react";
import { formatEstimatedTokens, meterLevel, type ContextMeters as MeterSnapshot } from "@shared/memory";
import { isPersistedThreadId } from "@shared/thread-identity";
import { BrainIcon, GaugeIcon } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import styles from "./ContextMeters.module.css";
import type { AgentId } from "@shared/workflows";

const EMPTY: MeterSnapshot = {
  memoryTokens: 0,
  memoryBudget: 512,
  contextTokens: 0,
  contextWindow: 8192,
  lastInference: null,
};

function levelClass(used: number, total: number): string {
  const level = meterLevel(used, total);
  if (level === "high") return styles.high;
  if (level === "warn") return styles.warn;
  return styles.ok;
}

export function ContextMeters({ audience = "conversational" }: { audience?: AgentId }): ReactElement {
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const [snapshot, setSnapshot] = useState<{
    threadId: typeof threadId;
    audience: AgentId;
    meters: MeterSnapshot;
  }>();
  const meters = snapshot?.threadId === threadId && snapshot.audience === audience ? snapshot.meters : EMPTY;

  useEffect(() => {
    let cancelled = false;
    let latestLoad = 0;
    let loading = false;
    const load = (): void => {
      if (document.hidden || loading) return;
      loading = true;
      const loadId = ++latestLoad;
      void window.verbo.context
        .estimate({
          audience,
          ...(isPersistedThreadId(threadId) ? { threadId } : {}),
        })
        .then((next) => {
          if (!cancelled && loadId === latestLoad) setSnapshot({ threadId, audience, meters: next });
        })
        .catch(() => undefined)
        .finally(() => {
          loading = false;
        });
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
  }, [threadId, audience]);

  const memoryPercent = meters.memoryBudget > 0 ? Math.round((meters.memoryTokens / meters.memoryBudget) * 100) : 0;
  const contextPercent = meters.contextWindow > 0 ? Math.round((meters.contextTokens / meters.contextWindow) * 100) : 0;
  const memoryLabel = [
    `${audience} context notes: about ${memoryPercent}% of the global always-on budget (${meters.memoryTokens} of ${meters.memoryBudget} estimated tokens).`,
    "Only notes explicitly assigned to this recipient are counted. Unassigned and other recipients' notes are excluded.",
    "Thread notes apply only within their chat; on-demand notes require authorized retrieval.",
    "Size is a guess: about four letters make one token.",
    `The pile stops at ${meters.memoryBudget}. Near the top, shorten a fact or save it as on-demand so another always-on fact can still fit.`,
    "Color stays calm under 70% full, turns cautious from 70% to 90%, and turns urgent past 90%.",
  ].join(" ");

  const contextLabel = [
    `The gauge is how full the model's reading window looks for the next reply: about ${contextPercent}% (${meters.contextTokens} of ${meters.contextWindow} guessed tokens).`,
    "It adds Verbo's instructions, the always-on facts, this chat's pinned notes, and the newest messages that still fit.",
    "Words still in the box wait until you send them. Older messages drop off once the pile is tall.",
    "About a quarter of the window stays spare on purpose, so a long chat usually levels off near 75% and may already look cautious.",
    "The gauge climbs toward the whole window only when the instructions and required pieces alone are crowded.",
    "Each message is guessed at about four letters per token, plus a little extra for the message itself.",
    meters.lastInference === null
      ? `No ${audience} request has been measured for this chat in this session.`
      : `Latest ${audience} request: ${meters.lastInference.status}. Model: ${meters.lastInference.model}. Turn: ${meters.lastInference.turnId ?? "unavailable"}. Invocation: ${meters.lastInference.invocationId}. Request: ${meters.lastInference.requestId}. ${meters.lastInference.promptTokens === undefined ? "Prompt count unavailable." : `Ollama processed ${meters.lastInference.promptTokens} prompt tokens in this single request; this is not a sum across calls.`} That count can differ from the next-reply estimate.`,
  ].join(" ");

  return (
    <div className={styles.meters}>
      <Tooltip label={memoryLabel} multiline w={320}>
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
      <Tooltip label={contextLabel} multiline w={320}>
        <span
          aria-label={`Context ${formatEstimatedTokens(meters.contextTokens)} / ${formatEstimatedTokens(meters.contextWindow)}`}
          className={`${styles.meter} ${levelClass(meters.contextTokens, meters.contextWindow)}`}
        >
          <GaugeIcon aria-hidden="true" className={styles.icon} />
          <span>
            {formatEstimatedTokens(meters.contextTokens)} / {formatEstimatedTokens(meters.contextWindow)}
          </span>
        </span>
      </Tooltip>
    </div>
  );
}
