import { Tooltip } from "@mantine/core";
import { useAuiState } from "@assistant-ui/react";
import { useMemo, useSyncExternalStore, type ReactElement } from "react";
import { executionTraceSchema } from "@shared/execution-trace";
import { timestampMs } from "@/runtime/thread-activity";
import {
  formatLocalInstant,
  formatTimeAgo,
  readClock,
  subscribeClock,
} from "@/runtime/relative-time";
import { messageSentAt, subscribeMessageTimes } from "@/runtime/message-time";
import styles from "./thread.module.css";

function traceReadyAt(
  parts: readonly { type: string; name?: string; data?: unknown }[],
): number | undefined {
  for (const part of parts) {
    if (part.type !== "data" || part.name !== "execution-trace") continue;
    const parsed = executionTraceSchema.safeParse(part.data);
    return parsed.success ? parsed.data.timing.resultReadyAt : undefined;
  }
  return undefined;
}

export function MessageTime(): ReactElement | null {
  const role = useAuiState((state) => state.message.role);
  const id = useAuiState((state) => state.message.id);
  const running = useAuiState(
    (state) => state.message.status?.type === "running",
  );
  const createdAt = useAuiState((state) =>
    timestampMs(state.message.createdAt),
  );
  const readyAt = useAuiState((state) =>
    state.message.role === "assistant"
      ? traceReadyAt(state.message.parts)
      : undefined,
  );
  const sent = useSyncExternalStore(
    subscribeMessageTimes,
    () => messageSentAt(id),
    () => messageSentAt(id),
  );
  const now = useSyncExternalStore(subscribeClock, readClock, () => Date.now());
  const at = useMemo(() => {
    if (role === "assistant") {
      if (readyAt !== undefined) return readyAt;
      if (running) return undefined;
      return createdAt || undefined;
    }
    return sent ?? (createdAt || undefined);
  }, [createdAt, readyAt, role, running, sent]);
  if (at === undefined) return null;
  const label = formatLocalInstant(at);
  return (
    <Tooltip label={label}>
      <time
        className={styles.messageTime}
        dateTime={new Date(at).toISOString()}
        tabIndex={0}
      >
        {formatTimeAgo(at, now)}
      </time>
    </Tooltip>
  );
}
