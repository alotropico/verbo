import { useAuiState } from "@assistant-ui/react";
import { UnstyledButton } from "@mantine/core";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  CircleStopIcon,
  ClockIcon,
  CopyIcon,
  MinusIcon,
  TriangleAlertIcon,
  CircleAlertIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  activitySummaryText,
  executionTraceSchema,
  formatWorkDuration,
  liveWorkMs,
  normalizeTracePresentation,
  type ExecutionTrace,
  type TraceNode,
  type TraceOutcome,
} from "@shared/execution-trace";
import { cx } from "@/lib/cx";
import { readClock, subscribeClock } from "@/runtime/relative-time";
import { PendingIndicator } from "./pending-indicator";
import { TooltipIconButton } from "./tooltip-icon-button";
import { ApprovalRequests } from "./approval-region";
import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./collapsible-root";
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
    if (parsed.success) return normalizeTracePresentation(parsed.data);
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
    return parsed.success ? normalizeTracePresentation(parsed.data) : undefined;
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
        <PendingIndicator size="compact" />
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
    if (node.kind !== "call") return node.summary ? [node.summary] : [];
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
  call,
  children,
  highlight,
  onHighlightEnd,
}: {
  node: TraceNode;
  call?: ReactNode;
  children?: ReactNode;
  highlight?: number;
  onHighlightEnd: () => void;
}): ReactElement {
  return (
    <li id={`trace-node-${node.id}`} className={styles.row}>
      <div className={cx(styles.entry, call && styles.toolEntry)}>
        {highlight !== undefined ? (
          <span
            key={highlight}
            className={styles.highlight}
            aria-hidden
            onAnimationEnd={onHighlightEnd}
          />
        ) : null}
        {call || (
          <div className={styles.rowHeader}>
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
                <CollapsibleRoot className={styles.technical}>
                  <CollapsibleTrigger className={styles.technicalTrigger}>
                    <ChevronRightIcon
                      className={styles.chevron}
                      size={12}
                      aria-hidden
                    />
                    Technical details
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {node.technical.map((field) => (
                      <p className={styles.detail} key={field.label}>
                        <span>
                          {field.label}: {field.value}
                        </span>
                        <TooltipIconButton
                          size="xs"
                          tooltip={`Copy ${field.label.toLowerCase()}`}
                          aria-label={`Copy ${field.label}`}
                          onClick={() => {
                            void window.verbo.clipboard.writeText(field.value);
                          }}
                        >
                          <CopyIcon size={12} aria-hidden />
                        </TooltipIconButton>
                      </p>
                    ))}
                  </CollapsibleContent>
                </CollapsibleRoot>
              ) : null}
            </div>
          </div>
        )}
      </div>
      {children}
    </li>
  );
}

export function ExecutionTraceView({
  trace,
  active = false,
  renderCall,
}: {
  trace: ExecutionTrace;
  active?: boolean;
  renderCall?: (node: TraceNode) => ReactNode;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const [reveal, setReveal] = useState<{ id: string; sequence: number }>();
  const scrollTo = useRef<string | undefined>(undefined);
  const waitingKey = trace.nodes
    .filter((node) => node.lifecycle === "waiting")
    .map((node) => node.id)
    .join("|");
  const [seenWaiting, setSeenWaiting] = useState("");
  if (waitingKey !== seenWaiting) {
    setSeenWaiting(waitingKey);
    if (waitingKey) {
      setExpanded(true);
      setReveal((previous) => ({
        id: waitingKey.split("|")[0],
        sequence: (previous?.sequence ?? 0) + 1,
      }));
    }
  }
  const now = useSyncExternalStore(subscribeClock, readClock, () => Date.now());
  const phases = trace.nodes
    .filter(
      (node) =>
        node.kind === "routing" ||
        node.kind === "workflow" ||
        node.kind === "reply",
    )
    .sort((left, right) => left.order - right.order);
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
  }, [expanded, reveal]);

  const focusPhase = (id: string): void => {
    scrollTo.current = id;
    setReveal((previous) => ({ id, sequence: (previous?.sequence ?? 0) + 1 }));
    setExpanded(true);
  };

  const childrenOf = (id: string): TraceNode[] =>
    trace.nodes
      .filter((node) => node.parentId === id)
      .sort((left, right) => left.order - right.order);

  const renderTree = (nodes: TraceNode[]): ReactElement[] =>
    nodes.map((node) => {
      const call = node.kind === "call" ? renderCall?.(node) : null;
      const children = childrenOf(node.id);
      return (
        <TraceRow
          key={node.id}
          node={node}
          call={call}
          highlight={reveal?.id === node.id ? reveal.sequence : undefined}
          onHighlightEnd={() => {
            setReveal((current) => (current === reveal ? undefined : current));
          }}
        >
          {children.length > 0 ? (
            <ol className={styles.children}>{renderTree(children)}</ol>
          ) : null}
        </TraceRow>
      );
    });

  const logNodes = trace.nodes
    .filter(
      (node) => !trace.nodes.some((parent) => parent.id === node.parentId),
    )
    .sort((left, right) => left.order - right.order);

  return (
    <CollapsibleRoot
      className={styles.activity}
      open={expanded}
      onOpenChange={(open) => {
        setExpanded(open);
        if (!open) setReveal(undefined);
      }}
      render={<section aria-label="Activity" />}
    >
      <div
        className={styles.path}
        aria-label={active ? "Turn in progress" : "Turn activity"}
      >
        {roots.map((node) => (
          <UnstyledButton
            key={node.id}
            type="button"
            className={styles.phase}
            data-active={
              node.lifecycle === "running" || node.lifecycle === "waiting"
            }
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => focusPhase(node.id)}
          >
            <span>{node.label}</span>
            <OutcomeMark node={node} />
          </UnstyledButton>
        ))}
        {active && trace.readiness === "ready" ? (
          <span className={styles.phase} data-active="true">
            <span>Finishing</span>
            <PendingIndicator size="compact" />
          </span>
        ) : null}
      </div>
      <CollapsibleTrigger className={styles.summary}>
        <ChevronRightIcon className={styles.chevron} size={14} aria-hidden />
        <span>
          {waitingKey ? `Approval needed · ${summary}` : summary || "Activity"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent id={detailsId} className={styles.details}>
        <ApprovalRequests>
          {wait ? <p className={styles.detail}>{wait}</p> : null}
          <ol className={styles.log}>{renderTree(logNodes)}</ol>
        </ApprovalRequests>
      </CollapsibleContent>
    </CollapsibleRoot>
  );
}
