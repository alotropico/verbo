"use client";

import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
} from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleHelpIcon,
  CircleMinusIcon,
  LoaderIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import {
  toolApprovalAcceptsText,
  useAuiState,
  useScrollLock,
  useToolCallElapsed,
  type ToolApprovalAnswer,
  type ToolApprovalOption,
  type ToolApprovalQuestion,
  type ToolCallMessagePart,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { StatusMessage } from "@/components/StatusMessage";
import { cx } from "@/lib/cx";
import styles from "./tool-fallback.aui.module.css";
import {
  CollapsibleRoot as Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible-root";
import { FilePageTable } from "@/components/FilePageTable";
import { readFilePage, type FilePageView } from "@shared/file-page";
import { isPersistedThreadId } from "@shared/thread-identity";
import { OperationReviewCard } from "./operation-review";
import { Button, Textarea } from "@mantine/core";
import { isPendingApprovalResult } from "@shared/tool-result-label";
import { describeApprovalRequest } from "@/runtime/approval-notice";
import { ExternalApproval } from "./approval-region";
import {
  OutcomeMark,
  traceNodeLabel,
  useTraceNode,
} from "./execution-trace-view";
import { PendingIndicator } from "./pending-indicator";

const ANIMATION_DURATION = 200;

export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll();
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cx("aui-tool-fallback-root", styles.root, className)}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  );
}

type ToolStatus = ToolCallMessagePartStatus["type"];

const statusIconMap: Record<ToolStatus, LucideIcon> = {
  running: LoaderIcon,
  complete: CircleHelpIcon,
  incomplete: XCircleIcon,
  "requires-action": AlertCircleIcon,
};

const formatToolDuration = (ms: number) => {
  if (ms < 1000) return "<1s";
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
};

function ToolFallbackDuration({
  className,
  ...props
}: React.ComponentProps<"span">) {
  const elapsedMs = useToolCallElapsed();
  if (elapsedMs === undefined) return null;

  return (
    <span
      data-slot="tool-fallback-duration"
      className={cx("aui-tool-fallback-duration", styles.duration, className)}
      {...props}
    >
      {formatToolDuration(elapsedMs)}
    </span>
  );
}

function ToolFallbackTrigger({
  toolName,
  toolCallId,
  status,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  toolCallId?: string;
  status?: ToolCallMessagePartStatus;
}) {
  const node = useTraceNode(toolCallId);
  const statusType = status?.type ?? "complete";
  const isRunning = statusType === "running";
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";

  const Icon = statusIconMap[statusType];
  const label = node
    ? traceNodeLabel(node)
    : statusType === "running"
      ? "Running"
      : statusType === "requires-action"
        ? "Waiting for approval"
        : statusType === "incomplete"
          ? isCancelled
            ? "Stopped"
            : "Failed"
          : "Unverified";

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      data-status={statusType}
      className={cx("aui-tool-fallback-trigger", styles.trigger, className)}
      {...props}
    >
      {node ? (
        <OutcomeMark node={node} />
      ) : isRunning ? (
        <PendingIndicator label="Running" size="compact" />
      ) : (
        <Icon
          data-slot="tool-fallback-trigger-icon"
          className={cx(
            "aui-tool-fallback-trigger-icon",
            styles.triggerIcon,
            isCancelled && styles.triggerIconCancelled,
            isRunning && styles.triggerIconRunning,
          )}
        />
      )}
      <span
        data-slot="tool-fallback-trigger-label"
        className={cx(
          "aui-tool-fallback-trigger-label-wrapper",
          styles.triggerLabel,
          isCancelled && styles.triggerLabelCancelled,
          isRunning && "shimmer",
        )}
      >
        {label} <span className={styles.toolName}>{toolName}</span>
      </span>
      <ToolFallbackDuration />
      <ChevronDownIcon
        data-slot="tool-fallback-trigger-chevron"
        className={cx("aui-tool-fallback-trigger-chevron", styles.chevron)}
      />
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cx("aui-tool-fallback-content", styles.content, className)}
      {...props}
    >
      <div className={styles.contentInner}>{children}</div>
    </CollapsibleContent>
  );
}

function ToolFallbackArgs({
  argsText,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  argsText?: string;
}) {
  if (!argsText) return null;

  return (
    <div
      data-slot="tool-fallback-args"
      className={cx("aui-tool-fallback-args", className)}
      {...props}
    >
      <p className={styles.resultHeader}>Input</p>
      <pre className={cx("aui-tool-fallback-args-value", styles.argsValue)}>
        {argsText}
      </pre>
    </div>
  );
}

const formatUnknownValue = (value: unknown, space?: number): string => {
  if (typeof value === "string") return value;

  try {
    if (value instanceof Error) return String(value);

    const json = JSON.stringify(value, null, space);
    if (json !== undefined) return json;
  } catch {
    // Circular or BigInt values fall through to String().
  }

  try {
    return String(value);
  } catch {
    return "[Unserializable value]";
  }
};

function ToolFallbackResult({
  result,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  result?: unknown;
}): React.ReactElement | null {
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const parsed = readFilePage(result);
  const [override, setOverride] = useState<{
    source: unknown;
    page: FilePageView;
  } | null>(null);
  if (result === undefined) return null;
  const shown = override?.source === result ? override.page : parsed;

  return (
    <div
      data-slot="tool-fallback-result"
      className={cx("aui-tool-fallback-result", className)}
      {...props}
    >
      {isPendingApprovalResult(result) ? null : (
        <OperationReviewCard result={result} />
      )}
      {shown ? (
        <FilePageTable
          page={shown}
          {...(isPersistedThreadId(threadId)
            ? {
                threadId,
                onPage: (page: FilePageView) =>
                  setOverride({ source: result, page }),
              }
            : {})}
        />
      ) : (
        <>
          <p
            className={cx(
              "aui-tool-fallback-result-header",
              styles.resultHeader,
            )}
          >
            Output
          </p>
          <pre
            className={cx(
              "aui-tool-fallback-result-content",
              styles.resultContent,
            )}
          >
            {formatUnknownValue(result, 2)}
          </pre>
        </>
      )}
    </div>
  );
}

function ToolFallbackError({
  status,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  status?: ToolCallMessagePartStatus;
}) {
  if (status?.type !== "incomplete") return null;

  const error = status.error;
  const errorText =
    error === undefined || error === null ? null : formatUnknownValue(error);

  if (!errorText) return null;

  const isCancelled = status.reason === "cancelled";
  const headerText = isCancelled ? "Cancelled reason:" : "Error:";

  return (
    <div
      data-slot="tool-fallback-error"
      className={cx("aui-tool-fallback-error", className)}
      {...props}
    >
      <StatusMessage
        display="plain"
        size="sm"
        tone={isCancelled ? "warning" : "error"}
      >
        {headerText} {errorText}
      </StatusMessage>
    </div>
  );
}

const APPROVED_RESULT = "Approved by user";
const DENIED_RESULT = "User denied tool execution";

const APPROVAL_OPTION_DEFAULT_LABELS: Record<string, string> = {
  "allow-once": "Allow",
  "allow-always": "Always allow",
  "reject-once": "Deny",
  "reject-always": "Always deny",
};

const isKnownKind = (kind: string) =>
  Object.hasOwn(APPROVAL_OPTION_DEFAULT_LABELS, kind);

const isAllowKind = (kind: string) =>
  kind === "allow-once" || kind === "allow-always";

const approvalOptionLabel = (option: ToolApprovalOption) =>
  option.label ??
  (isKnownKind(option.kind)
    ? APPROVAL_OPTION_DEFAULT_LABELS[option.kind]
    : undefined) ??
  option.id;

/**
 * A request that declares how it wants to be presented is asking a question,
 * not gating an action, so a refusal is not one of the answers it accepts
 * unless the request declares itself dismissible.
 */
const isQuestion = (approval: ToolCallMessagePart["approval"]) =>
  approval?.display === "select" ||
  approval?.display === "text" ||
  approval?.display === "questions";

const questionAcceptsText = (question: ToolApprovalQuestion) =>
  !question.options?.length || question.allowFreeform === true;

const answerLabels = (
  question: ToolApprovalQuestion,
  answer: ToolApprovalAnswer | undefined,
) => [
  ...(answer?.optionIds ?? []).map(
    (id) => question.options?.find((option) => option.id === id)?.label ?? id,
  ),
  ...(answer?.text?.trim() ? [answer.text] : []),
];

const isSettled = (approval: ToolCallMessagePart["approval"]) =>
  approval != null &&
  (approval.approved !== undefined || approval.resolution !== undefined);

type ApprovalReceipt = {
  outcome: "allowed" | "refused" | "closed";
  label: string;
  option?: string | undefined;
};

/**
 * A settled request reads as a past-tense record of what happened to it, so
 * scrolling back never shows a live control for a decision already made.
 */
const approvalReceipt = (
  approval: NonNullable<ToolCallMessagePart["approval"]>,
): ApprovalReceipt => {
  if (approval.resolution !== undefined)
    return {
      outcome: "closed",
      label:
        approval.resolution === "cancelled"
          ? "Cancelled before a decision"
          : "Expired before a decision",
    };

  const chosen =
    approval.optionId === undefined
      ? undefined
      : approval.options?.find((option) => option.id === approval.optionId);
  const option =
    chosen !== undefined
      ? approvalOptionLabel(chosen)
      : approval.optionId === undefined
        ? undefined
        : approval.optionId;
  const answered =
    isQuestion(approval) || (chosen !== undefined && !isKnownKind(chosen.kind));
  const automatic = approval.isAutomatic ? " automatically" : "";

  if (approval.approved)
    return {
      outcome: "allowed",
      label: `${answered ? "Answered" : "Allowed"}${automatic}`,
      option,
    };
  return {
    outcome: "refused",
    label: `${answered ? "Dismissed" : "Denied"}${automatic}`,
    option,
  };
};

const receiptIcons = {
  allowed: CheckIcon,
  refused: XCircleIcon,
  closed: CircleMinusIcon,
} satisfies Record<ApprovalReceipt["outcome"], React.ElementType>;

function ToolFallbackApprovalReceipt({
  approval,
  className,
  focusReceiptRef,
  receiptRef,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & {
  approval: NonNullable<ToolCallMessagePart["approval"]>;
  focusReceiptRef: React.MutableRefObject<string | null | undefined>;
  receiptRef: React.MutableRefObject<HTMLDivElement | null>;
}) {
  useLayoutEffect(() => {
    const shouldFocus = focusReceiptRef.current === approval.id;
    focusReceiptRef.current = null;
    if (shouldFocus) receiptRef.current?.focus({ preventScroll: true });
  }, [approval.id, focusReceiptRef, receiptRef]);

  const receipt = approvalReceipt(approval);
  const Icon = receiptIcons[receipt.outcome];
  const notes = [
    ...new Set(
      [approval.text, approval.reason].filter(
        (value): value is string => typeof value === "string" && value !== "",
      ),
    ),
  ];

  return (
    <div
      ref={receiptRef}
      data-slot="tool-fallback-approval-receipt"
      data-outcome={receipt.outcome}
      tabIndex={-1}
      className={cx(
        "aui-tool-fallback-approval-receipt",
        styles.approvalReceipt,
        className,
      )}
      {...props}
    >
      {approval.prompt ? (
        <p
          className={cx(
            "aui-tool-fallback-approval-prompt",
            styles.approvalPrompt,
          )}
        >
          {approval.prompt}
        </p>
      ) : null}
      <p
        className={cx(
          "aui-tool-fallback-approval-receipt-label",
          styles.receiptLabel,
        )}
      >
        <Icon aria-hidden className={styles.receiptIcon} />
        <span className={styles.fontMedium}>{receipt.label}</span>
        {receipt.option !== undefined ? (
          <span className={styles.receiptOption}>· {receipt.option}</span>
        ) : null}
      </p>
      {approval.answers &&
        approval.questions?.map((question) => {
          const labels = answerLabels(
            question,
            approval.answers && Object.hasOwn(approval.answers, question.id)
              ? approval.answers[question.id]
              : undefined,
          );
          if (labels.length === 0) return null;
          return (
            <p
              key={question.id}
              className={cx(
                "aui-tool-fallback-approval-receipt-answer",
                styles.receiptAnswer,
              )}
            >
              <span className={styles.receiptOption}>
                {question.header ?? question.prompt}
              </span>{" "}
              · {labels.join(", ")}
            </p>
          );
        })}
      {notes.map((text) => (
        <p
          key={text}
          className={cx(
            "aui-tool-fallback-approval-receipt-note",
            styles.receiptNote,
          )}
        >
          {text}
        </p>
      ))}
    </div>
  );
}

function ToolFallbackApprovalQuestions({
  questions,
  dismissible,
  locked,
  onSend,
  onDismiss,
}: {
  questions: readonly ToolApprovalQuestion[];
  dismissible: boolean;
  locked: boolean;
  onSend: (answers: Record<string, ToolApprovalAnswer>) => void;
  onDismiss: () => void;
}) {
  const [selected, setSelected] = useState<
    ReadonlyMap<string, readonly string[]>
  >(() => new Map());
  const [typed, setTyped] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  const toggle = (question: ToolApprovalQuestion, optionId: string) =>
    setSelected((current) => {
      const chosen = current.get(question.id) ?? [];
      const next = chosen.includes(optionId)
        ? chosen.filter((id) => id !== optionId)
        : question.multiple
          ? [...chosen, optionId]
          : [optionId];
      return new Map(current).set(question.id, next);
    });

  const answerOf = (question: ToolApprovalQuestion): ToolApprovalAnswer => {
    const optionIds = selected.get(question.id) ?? [];
    const draft = typed.get(question.id);
    const text = draft?.trim() ? draft : undefined;
    return {
      ...(optionIds.length > 0 && { optionIds }),
      ...(text !== undefined && { text }),
    };
  };

  const complete =
    questions.length > 0 &&
    questions.every((question) => {
      const answer = answerOf(question);
      return answer.optionIds !== undefined || answer.text !== undefined;
    });

  const send = () => {
    if (locked || !complete) return;
    onSend(
      Object.fromEntries(
        questions.map((question) => [question.id, answerOf(question)]),
      ),
    );
  };

  return (
    <>
      {questions.map((question) => {
        const chosen = selected.get(question.id) ?? [];
        const described =
          question.options?.some((option) => option.description) ?? false;
        return (
          <div
            key={question.id}
            role="group"
            aria-label={question.prompt}
            data-slot="tool-fallback-approval-question"
            className={cx(
              "aui-tool-fallback-approval-question",
              styles.approvalQuestion,
            )}
          >
            <p
              className={cx(
                "aui-tool-fallback-approval-question-prompt",
                styles.questionPrompt,
              )}
            >
              {question.header ? (
                <span className={styles.questionHeader}>{question.header}</span>
              ) : null}
              {question.prompt}
            </p>
            {question.options && question.options.length > 0 ? (
              <div
                className={described ? styles.optionsCol : styles.optionsRow}
              >
                {question.options.map((option) => {
                  const pressed = chosen.includes(option.id);
                  return (
                    <Button
                      key={option.id}
                      size="sm"
                      variant={pressed ? "filled" : "outline"}
                      className={cx(
                        styles.pressable,
                        described && styles.optionButtonStack,
                      )}
                      aria-pressed={pressed}
                      onClick={() => toggle(question, option.id)}
                      disabled={locked}
                    >
                      <span>{option.label}</span>
                      {option.description ? (
                        <span className={styles.optionDescription}>
                          {option.description}
                        </span>
                      ) : null}
                    </Button>
                  );
                })}
              </div>
            ) : null}
            {questionAcceptsText(question) ? (
              <Textarea
                value={typed.get(question.id) ?? ""}
                onChange={(event) =>
                  setTyped((current) =>
                    new Map(current).set(question.id, event.target.value),
                  )
                }
                disabled={locked}
                aria-label={question.prompt}
                placeholder={
                  question.options?.length
                    ? "Or type an answer"
                    : "Type your answer"
                }
              />
            ) : null}
          </div>
        );
      })}
      <div className={styles.actionsRow}>
        <Button
          size="sm"
          className={styles.pressable}
          onClick={send}
          disabled={locked || !complete}
        >
          Send
        </Button>
        {dismissible ? (
          <Button
            size="sm"
            variant="outline"
            className={styles.pressable}
            onClick={onDismiss}
            disabled={locked}
          >
            Dismiss
          </Button>
        ) : null}
      </div>
    </>
  );
}

const offersInterruptAction = (
  status: ToolCallMessagePartStatus | undefined,
  approval: ToolCallMessagePart["approval"],
  interrupt: ToolCallMessagePart["interrupt"],
) =>
  status?.type !== "requires-action" ||
  status.reason !== "interrupt" ||
  approval != null ||
  interrupt != null;

type ToolFallbackApprovalProps = React.ComponentPropsWithoutRef<"div"> &
  Partial<
    Pick<
      ToolCallMessagePartProps,
      "addResult" | "resume" | "respondToApproval" | "status"
    >
  > & {
    interrupt?: ToolCallMessagePart["interrupt"];
    approval?: ToolCallMessagePart["approval"];
  };

const ToolFallbackApproval: React.ForwardRefExoticComponent<
  ToolFallbackApprovalProps & React.RefAttributes<HTMLDivElement>
> = forwardRef<HTMLDivElement, ToolFallbackApprovalProps>(
  function ToolFallbackApproval(props, ref) {
    const carryFocusRef = useRef(false);
    return (
      <ToolFallbackApprovalImpl
        key={props.approval?.id}
        carryFocusRef={carryFocusRef}
        forwardedRef={ref}
        {...props}
      />
    );
  },
);

function ToolFallbackApprovalImpl({
  className,
  forwardedRef,
  carryFocusRef,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
  status,
  ...props
}: Omit<ToolFallbackApprovalProps, "ref"> & {
  forwardedRef: React.ForwardedRef<HTMLDivElement>;
  carryFocusRef: React.MutableRefObject<boolean>;
}) {
  const [submitted, setSubmitted] = useState(false);
  const voiceActive = useAuiState((s) => s.thread.voice !== undefined);
  const canAnswer = useAuiState((s) => s.thread.capabilities.answerToolCall);
  const locked = submitted || voiceActive;
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isRequiresAction = status?.type === "requires-action";
  const [prevRequiresAction, setPrevRequiresAction] =
    useState(isRequiresAction);
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(attempt);
  useLayoutEffect(() => {
    attemptRef.current = attempt;
  }, [attempt]);
  if (isRequiresAction !== prevRequiresAction) {
    setPrevRequiresAction(isRequiresAction);
    if (isRequiresAction) {
      setSubmitted(false);
      setConfirmingId(null);
      setAnswer("");
      setError(null);
      setAttempt(attempt + 1);
    }
  }
  const pendingGroupRef = useRef<HTMLDivElement | null>(null);
  const receiptRef = useRef<HTMLDivElement | null>(null);
  const focusReceiptRef = useRef<string | null | undefined>(null);
  useLayoutEffect(() => {
    if (carryFocusRef.current) {
      carryFocusRef.current = false;
      pendingGroupRef.current?.focus({ preventScroll: true });
    }
    return () => {
      const element = pendingGroupRef.current ?? receiptRef.current;
      carryFocusRef.current =
        element?.contains(element.ownerDocument.activeElement) ?? false;
    };
  }, [carryFocusRef]);
  useImperativeHandle<HTMLDivElement | null, HTMLDivElement | null>(
    forwardedRef,
    () => pendingGroupRef.current ?? receiptRef.current,
  );
  const setPendingGroup = useCallback(
    (element: HTMLDivElement | null) => {
      const group = pendingGroupRef.current;
      focusReceiptRef.current =
        !element && group?.contains(group.ownerDocument.activeElement)
          ? approval?.id
          : null;
      pendingGroupRef.current = element;
    },
    [approval?.id],
  );
  const hidePendingApproval =
    approval != null &&
    !isSettled(approval) &&
    status !== undefined &&
    status.type !== "requires-action" &&
    !(submitted && status.type === "running");
  useLayoutEffect(() => {
    if (hidePendingApproval) focusReceiptRef.current = null;
  }, [hidePendingApproval]);
  const focusPendingGroup = () => {
    const group = pendingGroupRef.current;
    if (group?.contains(group.ownerDocument.activeElement)) {
      group.focus({ preventScroll: true });
    }
  };

  if (approval != null && isSettled(approval))
    return (
      <ToolFallbackApprovalReceipt
        approval={approval}
        receiptRef={receiptRef}
        focusReceiptRef={focusReceiptRef}
        className={className}
        {...props}
      />
    );

  if (
    hidePendingApproval ||
    !offersInterruptAction(status, approval, interrupt)
  )
    return null;

  const promptText = approval?.prompt ? (
    <p
      className={cx(
        "aui-tool-fallback-approval-prompt",
        styles.approvalPromptForeground,
      )}
    >
      {approval.prompt}
    </p>
  ) : null;

  if (!canAnswer)
    return (
      promptText && (
        <div
          data-slot="tool-fallback-approval"
          tabIndex={-1}
          className={cx(
            "aui-tool-fallback-approval",
            styles.approvalStack,
            className,
          )}
          {...props}
          ref={setPendingGroup}
        >
          {promptText}
        </div>
      )
    );

  // A declared option list is a host constraint: the kit never adds an
  // approval path beyond it, and preserves a refusal path only where the
  // request is an action the user may refuse.
  const declaredOptions = respondToApproval ? approval?.options : undefined;
  const acceptsText =
    approval != null &&
    respondToApproval != null &&
    toolApprovalAcceptsText(approval);

  // A refused response leaves the request open, so the controls come back
  // rather than staying spent on a decision the runtime never recorded.
  const submit = (send: () => Promise<void> | void) => {
    focusPendingGroup();
    setSubmitted(true);
    setConfirmingId(null);
    setError(null);
    void (async () => {
      try {
        await send();
      } catch (sendError) {
        if (attemptRef.current !== attempt) return;
        setSubmitted(false);
        setError(
          sendError instanceof Error ? sendError.message : String(sendError),
        );
      }
    })();
  };

  const respond = (approved: boolean) => {
    if (locked) return;
    if (
      approval != null &&
      approval.approved === undefined &&
      respondToApproval
    ) {
      submit(() => respondToApproval({ approved, ...typedNote() }));
    } else if (interrupt) {
      submit(() => resume?.({ approved }));
    } else if (
      status?.type === "requires-action" &&
      status.reason === "interrupt"
    ) {
      return;
    } else {
      submit(() => addResult?.(approved ? APPROVED_RESULT : DENIED_RESULT));
    }
  };

  const respondWithOption = (option: ToolApprovalOption) => {
    if (locked) return;
    // A custom kind has no decision class for the runtime to derive, and
    // responding without one throws; picking a declared option is an answer,
    // so it resolves as approved.
    submit(() =>
      respondToApproval?.(
        isKnownKind(option.kind)
          ? { optionId: option.id, ...typedNote() }
          : { optionId: option.id, approved: true, ...typedNote() },
      ),
    );
  };

  const typedNote = () => (answer.trim() ? { text: answer } : {});

  // The kit does not validate an answer the request never constrained: a host
  // that cannot record an empty one rejects it, which reopens the controls.
  const submitAnswer = () => {
    if (locked) return;
    submit(() => respondToApproval?.({ text: answer }));
  };

  // A dismissal is no answer at all, so a typed draft does not travel with it.
  const dismiss = () => {
    if (locked) return;
    submit(() => respondToApproval?.({ approved: false }));
  };

  const handleOption = (option: ToolApprovalOption) => {
    if (option.confirm) {
      focusPendingGroup();
      setConfirmingId(option.id);
    } else {
      respondWithOption(option);
    }
  };

  const confirming =
    confirmingId != null
      ? declaredOptions?.find((o) => o.id === confirmingId)
      : undefined;

  const question = isQuestion(approval);
  const dismissible =
    question && respondToApproval != null && approval?.dismissible === true;

  const dismissButton = dismissible ? (
    <Button
      size="sm"
      variant="outline"
      className={styles.pressable}
      onClick={dismiss}
      disabled={locked}
    >
      Dismiss
    </Button>
  ) : null;

  const errorText = error ? (
    <StatusMessage display="plain" size="xs" tone="error">
      {error}
    </StatusMessage>
  ) : null;

  const answerField = acceptsText ? (
    <div
      className={cx("aui-tool-fallback-approval-answer", styles.approvalAnswer)}
    >
      <Textarea
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        disabled={locked}
        aria-label={question ? (approval?.prompt ?? "Answer") : "Note"}
        placeholder={
          question ? "Type your answer" : "Add a note to your decision"
        }
      />
      {question && (
        <div className={styles.actionsRow}>
          <Button
            size="sm"
            className={styles.pressable}
            onClick={submitAnswer}
            disabled={locked}
          >
            Send
          </Button>
          {dismissButton}
        </div>
      )}
    </div>
  ) : null;

  if (approval?.display === "questions" && respondToApproval) {
    return (
      <div
        data-slot="tool-fallback-approval"
        tabIndex={-1}
        className={cx(
          "aui-tool-fallback-approval",
          styles.approvalStack,
          styles.approvalStackLoose,
          className,
        )}
        {...props}
        ref={setPendingGroup}
      >
        {promptText}
        <ToolFallbackApprovalQuestions
          questions={approval.questions ?? []}
          dismissible={approval.dismissible === true}
          locked={locked}
          onSend={(answers) => submit(() => respondToApproval({ answers }))}
          onDismiss={dismiss}
        />
        {errorText}
      </div>
    );
  }

  if (confirming) {
    const confirmMeta =
      typeof confirming.confirm === "object" ? confirming.confirm : undefined;
    const confirmDescription =
      confirmMeta?.description ?? confirming.description;
    return (
      <div
        data-slot="tool-fallback-approval-confirm"
        tabIndex={-1}
        className={cx(
          "aui-tool-fallback-approval-confirm",
          styles.approvalStack,
          className,
        )}
        {...props}
        ref={setPendingGroup}
      >
        <p
          className={cx(
            "aui-tool-fallback-approval-confirm-title",
            styles.confirmTitle,
          )}
        >
          {confirmMeta?.title ?? `${approvalOptionLabel(confirming)}?`}
        </p>
        {confirmDescription && (
          <p
            className={cx(
              "aui-tool-fallback-approval-confirm-description",
              styles.confirmDescription,
            )}
          >
            {confirmDescription}
          </p>
        )}
        {confirming.grants && confirming.grants.length > 0 && (
          <ul
            className={cx(
              "aui-tool-fallback-approval-confirm-grants",
              styles.confirmGrants,
            )}
          >
            {confirming.grants.map((grant) => (
              <li key={grant}>
                <code
                  className={cx(
                    "aui-tool-fallback-approval-confirm-grant",
                    styles.confirmGrant,
                  )}
                >
                  {grant}
                </code>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.actionsRow}>
          <Button
            size="sm"
            className={styles.pressable}
            onClick={() => respondWithOption(confirming)}
            disabled={locked}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={styles.pressable}
            onClick={() => {
              focusPendingGroup();
              setConfirmingId(null);
            }}
            disabled={locked}
          >
            Back
          </Button>
        </div>
      </div>
    );
  }

  if (declaredOptions && declaredOptions.length > 0) {
    const allowOptions = declaredOptions.filter((o) => isAllowKind(o.kind));
    const customOptions = declaredOptions.filter((o) => !isKnownKind(o.kind));
    const rejectOptions = declaredOptions.filter(
      (o) => isKnownKind(o.kind) && !isAllowKind(o.kind),
    );
    return (
      <div
        data-slot="tool-fallback-approval"
        tabIndex={-1}
        className={cx(
          "aui-tool-fallback-approval",
          styles.approvalStack,
          className,
        )}
        {...props}
        ref={setPendingGroup}
      >
        {promptText}
        <div className={styles.optionsRow}>
          {[...allowOptions, ...customOptions, ...rejectOptions].map(
            (option) => (
              <Button
                key={option.id}
                size="sm"
                variant={option === allowOptions[0] ? "filled" : "outline"}
                className={styles.pressable}
                onClick={() => handleOption(option)}
                disabled={locked}
              >
                {approvalOptionLabel(option)}
              </Button>
            ),
          )}
          {rejectOptions.length === 0 && !question && (
            <Button
              size="sm"
              variant="outline"
              className={styles.pressable}
              onClick={() => respond(false)}
              disabled={locked}
            >
              Deny
            </Button>
          )}
          {!acceptsText && dismissButton}
        </div>
        {answerField}
        {errorText}
      </div>
    );
  }

  // A question carries no decision to fabricate, so it renders only what the
  // request declared, even when that leaves nothing to act on here.
  if (question) {
    return (
      <div
        data-slot="tool-fallback-approval"
        tabIndex={-1}
        className={cx(
          "aui-tool-fallback-approval",
          styles.approvalStack,
          className,
        )}
        {...props}
        ref={setPendingGroup}
      >
        {promptText}
        {answerField}
        {!acceptsText && dismissButton && (
          <div className={styles.actionsRow}>{dismissButton}</div>
        )}
        {errorText}
      </div>
    );
  }

  return (
    <div
      data-slot="tool-fallback-approval"
      tabIndex={-1}
      className={cx(
        "aui-tool-fallback-approval",
        styles.approvalStack,
        className,
      )}
      {...props}
      ref={setPendingGroup}
    >
      {promptText}
      <div className={styles.actionsRow}>
        <Button
          size="sm"
          className={styles.pressable}
          onClick={() => respond(true)}
          disabled={locked}
        >
          Allow
        </Button>
        <Button
          size="sm"
          variant="outline"
          className={styles.pressable}
          onClick={() => respond(false)}
          disabled={locked}
        >
          Deny
        </Button>
      </div>
      {answerField}
      {errorText}
    </div>
  );
}

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolCallId,
  toolName,
  argsText,
  result,
  status,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
}) => {
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";
  const isRequiresAction =
    status?.type === "requires-action" || isPendingApprovalResult(result);
  const shouldRenderApproval =
    approval != null ||
    (isRequiresAction && offersInterruptAction(status, approval, interrupt));

  const settledApproval = approval != null && isSettled(approval);
  const hiddenPending =
    approval != null &&
    !settledApproval &&
    status !== undefined &&
    status.type !== "requires-action";
  const externalApproval =
    shouldRenderApproval && !settledApproval && !hiddenPending;
  const request = describeApprovalRequest({
    type: "tool-call",
    toolCallId,
    result,
    status,
    approval,
  });
  const [open, setOpen] = useState(isRequiresAction);
  const [prevRequiresAction, setPrevRequiresAction] =
    useState(isRequiresAction);
  if (isRequiresAction !== prevRequiresAction) {
    setPrevRequiresAction(isRequiresAction);
    if (isRequiresAction) setOpen(true);
  }
  const approvalHadFocusRef = useRef(false);
  const approvalElementRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const focusedElement = approvalElementRef.current;
    if (
      !focusedElement ||
      focusedElement.isConnected ||
      isRequiresAction ||
      !approvalHadFocusRef.current
    ) {
      return;
    }

    const shouldFocusTrigger = approval == null || !isSettled(approval);
    approvalHadFocusRef.current = false;
    const { activeElement, body } = focusedElement.ownerDocument;
    if (
      shouldFocusTrigger &&
      (activeElement == null || activeElement === body)
    ) {
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [approval, isRequiresAction, status?.type]);

  const trackApprovalFocus = {
    onFocusCapture: (event: FocusEvent<HTMLDivElement>) => {
      triggerRef.current =
        frameRef.current?.querySelector<HTMLButtonElement>(
          '[data-slot="tool-fallback-trigger"]',
        ) ?? null;
      approvalElementRef.current = event.currentTarget;
      approvalHadFocusRef.current = true;
    },
    onBlurCapture: (event: FocusEvent<HTMLDivElement>) => {
      const relatedTarget = event.relatedTarget;
      const stillFocused = relatedTarget
        ? event.currentTarget.contains(relatedTarget as Node)
        : event.currentTarget.contains(
            event.currentTarget.ownerDocument.activeElement,
          );
      if (!stillFocused) approvalHadFocusRef.current = false;
    },
  };

  return (
    <div ref={frameRef} className={styles.toolFrame}>
      <ExternalApproval
        active={externalApproval}
        {...(request ? { noticeId: request.id, noticeBody: request.body } : {})}
      >
        <ToolFallbackApproval
          addResult={addResult}
          resume={resume}
          interrupt={interrupt}
          approval={approval}
          respondToApproval={respondToApproval}
          status={status}
          {...trackApprovalFocus}
        />
      </ExternalApproval>
      <ToolFallbackRoot open={open} onOpenChange={setOpen}>
        <ToolFallbackTrigger
          toolName={toolName}
          toolCallId={toolCallId}
          status={status}
        />
        <ToolFallbackContent>
          <ToolFallbackError status={status} />
          <ToolFallbackArgs
            argsText={argsText}
            className={cx(isCancelled && styles.cancelledFade)}
          />
          {settledApproval ? (
            <ToolFallbackApproval
              addResult={addResult}
              resume={resume}
              interrupt={interrupt}
              approval={approval}
              respondToApproval={respondToApproval}
              status={status}
              {...trackApprovalFocus}
            />
          ) : null}
          <ToolFallbackResult result={result} />
        </ToolFallbackContent>
      </ToolFallbackRoot>
    </div>
  );
};

const ToolFallback = memo(
  ToolFallbackImpl,
) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
  Approval: typeof ToolFallbackApproval;
};

ToolFallback.displayName = "ToolFallback";
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;
ToolFallback.Approval = ToolFallbackApproval;

export {
  formatUnknownValue,
  offersInterruptAction,
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
  ToolFallbackApproval,
};
