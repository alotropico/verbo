import { useAuiState } from "@assistant-ui/react";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleHelpIcon,
  CircleStopIcon,
  ClockIcon,
  MinusIcon,
  TriangleAlertIcon,
  CircleAlertIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from "react";
import {
  activitySummaryText,
  executionTraceSchema,
  formatWorkDuration,
  liveWorkMs,
  type ExecutionTrace,
  type TraceNode,
  type TraceOutcome,
} from "@shared/execution-trace";
import { cx } from "@/lib/cx";
import { readClock, subscribeClock } from "@/runtime/relative-time";
import { PendingIndicator } from "./pending-indicator";
import styles from "./execution-trace-view.module.css";

const OUTCOME_LABEL: Record<TraceOutcome, string> = {
  blocked: "Blocked",
  cancelled: "Stopped",
  failed: "Failed",
  partial: "Partial",
  skipped: "Not attempted",
  succeeded: "Completed",
  uncertain: "Uncertain",
  unverified: "Unverified",
};

export function traceFromParts(
  parts: readonly unknown[],
): ExecutionTrace | undefined {
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (!("type" in part) || part.type !== "data") continue;
    if (!("name" in part) || part.name !== "execution-trace") continue;
    if (!("data" in part)) continue;
    const parsed = executionTraceSchema.safeParse(part.data);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function useMessageTrace(): ExecutionTrace | undefined {
  const data = useAuiState((state) => {
    for (const part of state.message.parts) {
      if (part.type === "data" && part.name === "execution-trace")
        return part.data;
    }
    return undefined;
  });
  return useMemo(() => {
    const parsed = executionTraceSchema.safeParse(data);
    return parsed.success ? parsed.data : undefined;
  }, [data]);
}

export function useTraceNode(
  toolCallId: string | undefined,
): TraceNode | undefined {
  const trace = useMessageTrace();
  if (!toolCallId || !trace) return undefined;
  return trace.nodes.find(
    (node) =>
      node.id === toolCallId || node.correlation?.toolCallId === toolCallId,
  );
}

export function traceNodeLabel(node: TraceNode): string {
  if (node.lifecycle === "running") return "Running";
  if (node.lifecycle === "waiting") return "Waiting for approval";
  const outcome = OUTCOME_LABEL[node.outcome];
  return node.disposition === "reused" ? `${outcome}, reused` : outcome;
}

export function OutcomeMark({ node }: { node: TraceNode }): ReactElement {
  const label =
    node.lifecycle === "running"
      ? "Running"
      : node.lifecycle === "waiting"
        ? "Waiting"
        : node.disposition === "reused"
          ? `${OUTCOME_LABEL[node.outcome]}, reused`
          : OUTCOME_LABEL[node.outcome];
  return (
    <span
      className={styles.mark}
      data-severity={node.lifecycle === "running" ? "info" : node.severity}
      role="img"
      aria-label={label}
    >
      {node.lifecycle === "running" ? (
        <PendingIndicator />
      ) : node.lifecycle === "waiting" ? (
        <ClockIcon size={14} aria-hidden />
      ) : node.outcome === "succeeded" ? (
        <CheckIcon size={14} aria-hidden />
      ) : node.outcome === "failed" ? (
        <CircleAlertIcon size={14} aria-hidden />
      ) : node.outcome === "blocked" ||
        node.outcome === "partial" ||
        node.outcome === "uncertain" ? (
        <TriangleAlertIcon size={14} aria-hidden />
      ) : node.outcome === "cancelled" ? (
        <CircleStopIcon size={14} aria-hidden />
      ) : node.outcome === "skipped" ? (
        <MinusIcon size={14} aria-hidden />
      ) : (
        <CircleHelpIcon size={14} aria-hidden />
      )}
    </span>
  );
}

function subjectLines(node: TraceNode): string[] {
  const subjects = node.subjects ?? [];
  if (subjects.length === 0) {
    if (node.kind !== "call") return [];
    if (node.activity === "change" || node.activity === "read")
      return ["No trustworthy path was recorded for this operation."];
    return node.summary ? [node.summary] : [];
  }
  const lines: string[] = [];
  let source: string | undefined;
  for (const subject of subjects) {
    if (subject.role === "source") {
      if (source) lines.push(source);
      source = subject.path;
      continue;
    }
    lines.push(source ? `${source} → ${subject.path}` : subject.path);
    source = undefined;
  }
  if (source) lines.push(source);
  return lines;
}

function TraceRow({
  node,
  depth,
  focused,
}: {
  node: TraceNode;
  depth: number;
  focused: boolean;
}): ReactElement {
  return (
    <li
      id={`trace-node-${node.id}`}
      className={cx(styles.row, focused && styles.focused)}
      style={{ "--trace-depth": depth } as CSSProperties}
    >
      <OutcomeMark node={node} />
      <div className={styles.rowBody}>
        <span className={styles.rowLabel}>
          {node.label}
          {node.disposition === "reused" ? " · reused" : ""}
          {node.superseded ? " · superseded" : ""}
        </span>
        {subjectLines(node).map((line) => (
          <span className={styles.subject} key={line}>
            {line}
          </span>
        ))}
        {node.technical?.length ? (
          <div className={styles.technical}>
            {node.technical.map((field) => (
              <p className={styles.detail} key={field.label}>
                <span>
                  {field.label}: {field.value}
                </span>
                <button
                  type="button"
                  className={styles.copy}
                  onClick={() => {
                    void window.verbo.clipboard.writeText(field.value);
                  }}
                >
                  Copy
                </button>
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function ExecutionTraceView({
  trace,
}: {
  trace: ExecutionTrace;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [focusId, setFocusId] = useState<string | undefined>();
  const scrollTo = useRef<string | undefined>(undefined);
  const waitingKey = trace.nodes
    .filter((node) => node.lifecycle === "waiting")
    .map((node) => node.id)
    .join("|");
  const [seenWaiting, setSeenWaiting] = useState(waitingKey);
  if (waitingKey !== seenWaiting) {
    setSeenWaiting(waitingKey);
    if (waitingKey) {
      setExpanded(true);
      setFocusId(waitingKey.split("|")[0]);
    }
  }
  const now = useSyncExternalStore(subscribeClock, readClock, () => Date.now());
  const phases = trace.nodes.filter(
    (node) =>
      node.kind === "routing" ||
      node.kind === "workflow" ||
      node.kind === "reply",
  );
  const roots =
    phases.length > 0
      ? phases
      : trace.nodes.filter((node) => node.kind === "call" && !node.parentId);
  const workMs = liveWorkMs(trace, now) ?? trace.summary.workMs;
  const summary = activitySummaryText({
    ...trace.summary,
    ...(workMs !== undefined ? { workMs } : {}),
  });
  const wait =
    trace.summary.waitMs && trace.summary.waitMs > 0
      ? `Wait ${formatWorkDuration(trace.summary.waitMs)}`
      : undefined;

  useEffect(() => {
    const id = scrollTo.current;
    if (!id || !expanded) return;
    scrollTo.current = undefined;
    document.getElementById(`trace-node-${id}`)?.scrollIntoView({
      block: "nearest",
    });
  }, [expanded, focusId]);

  const focusPhase = (id: string): void => {
    scrollTo.current = id;
    setFocusId(id);
    setExpanded(true);
  };

  const childrenOf = (id: string): TraceNode[] =>
    trace.nodes
      .filter((node) => node.parentId === id)
      .sort((left, right) => left.order - right.order);

  const renderTree = (nodes: TraceNode[], depth: number): ReactElement[] =>
    nodes.flatMap((node) => [
      <TraceRow
        key={node.id}
        node={node}
        depth={depth}
        focused={focusId === node.id}
      />,
      ...renderTree(childrenOf(node.id), depth + 1),
    ]);

  const logNodes = trace.nodes
    .filter((node) => !node.parentId)
    .sort((left, right) => left.order - right.order);

  return (
    <section className={styles.activity} aria-label="Activity">
      <div className={styles.path}>
        {roots.map((node) => (
          <button
            key={node.id}
            type="button"
            className={styles.phase}
            aria-expanded={expanded}
            onClick={() => focusPhase(node.id)}
          >
            <span>{node.label}</span>
            <OutcomeMark node={node} />
          </button>
        ))}
      </div>
      <button
        type="button"
        className={styles.summary}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronDownIcon size={14} aria-hidden />
        <span>{summary || "Activity"}</span>
      </button>
      {expanded ? (
        <div className={styles.details}>
          {wait ? <p className={styles.detail}>{wait}</p> : null}
          <ol className={styles.log}>{renderTree(logNodes, 0)}</ol>
        </div>
      ) : null}
    </section>
  );
}
