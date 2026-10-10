"use client";

import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/elements/attachment.aui";
import { File, getFileHref } from "./file";
import { ThreadFollowupSuggestions } from "./follow-up-suggestions.aui";
import { Image } from "./image";
import { MarkdownText } from "./markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { TooltipIconButton } from "./tooltip-icon-button";
import { ActionIcon, Button, Skeleton } from "@mantine/core";
import { cx } from "@/lib/cx";
import a11y from "@/lib/a11y.module.css";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  AudioLinesIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  LightbulbIcon,
  MicIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PhoneIcon,
  RefreshCwIcon,
  SquareIcon,
  SparklesIcon,
  OrbitIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type FC,
  type PropsWithChildren,
} from "react";
import styles from "./thread.module.css";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

const reasoningDuration = (
  timing: ThreadGroupPart["timing"],
): number | undefined =>
  timing?.completedAt === undefined
    ? undefined
    : Math.round((timing.completedAt - timing.startedAt) / 1000);

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`. When `TaskGroup` is set, tool calls that carry a nested
 * conversation and have no registered UI render through it instead of the
 * tool group; without it they render like any other tool call.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
  ReasoningGroup?:
    ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>> | undefined;
  TaskGroup?: ComponentType<{ group: ThreadGroupPart }> | undefined;
};

const messageGroupBy = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
});

type ThreadGroupKey =
  "group-chainOfThought" | "group-reasoning" | "group-tool" | "group-task";

const TASK_GROUP_PATH: readonly ThreadGroupKey[] = [
  "group-chainOfThought",
  "group-task",
];

const taskAwareGroupBy = (
  part: Parameters<typeof messageGroupBy>[0],
  context?: Parameters<typeof messageGroupBy>[1],
): readonly ThreadGroupKey[] => {
  const path = messageGroupBy(part, context);
  return part.type === "tool-call" &&
    part.messages !== undefined &&
    path.length > 0 &&
    !context?.toolUIs?.[part.toolName]?.length
    ? TASK_GROUP_PATH
    : path;
};

export type ThreadProps = {
  components?: ThreadComponents | undefined;
  autoFocus?: boolean | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState): boolean =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState): boolean =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className={styles.historySkeleton}
  >
    <span className={a11y.srOnly}>Loading conversation</span>
    <Skeleton className={cx(styles.skeletonUser, styles.skeletonUserWide)} />
    <div className={styles.historySkeletonGroup}>
      <Skeleton className={cx(styles.skeletonLine, styles.skeletonWide)} />
      <Skeleton className={cx(styles.skeletonLine, styles.skeletonLong)} />
      <Skeleton className={cx(styles.skeletonLine, styles.skeletonShort)} />
    </div>
    <Skeleton className={cx(styles.skeletonUser, styles.skeletonUserNarrow)} />
    <div className={styles.historySkeletonGroup}>
      <Skeleton className={cx(styles.skeletonLine, styles.skeletonLong)} />
      <Skeleton className={cx(styles.skeletonLine, styles.skeletonMedium)} />
    </div>
  </div>
);

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot isEmpty={isEmpty} autoFocus={autoFocus} />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{ isEmpty: boolean; autoFocus: boolean }> = ({
  isEmpty,
  autoFocus,
}) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);

  return (
    <ThreadPrimitive.Root
      className={cx("aui-root", "aui-thread-root", styles.threadRoot)}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className={styles.viewport}
      >
        <div
          className={cx(styles.mainColumn, isEmpty && styles.mainColumnEmpty)}
        >
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>

          <ThreadLoadEarlier />

          <div data-slot="aui_message-group" className={styles.messageGroup}>
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cx(
              "aui-thread-viewport-footer",
              styles.viewportFooter,
              !isEmpty && styles.viewportFooterDocked,
            )}
          >
            <ThreadFollowupSuggestions />
            <Composer autoFocus={autoFocus} />
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
        <ThreadScrollToBottom />
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  const isSpoken = useAuiState((s) => s.message.metadata.modality === "voice");

  if (isEditing) return <EditComposer />;
  if (isSpoken) return <SpokenMessage />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

type VoiceRunPosition = "single" | "start" | "middle" | "end";

const useVoiceRunPosition = (): VoiceRunPosition =>
  useAuiState((s) => {
    const before =
      s.thread.messages[s.message.index - 1]?.metadata.modality === "voice";
    const after =
      s.thread.messages[s.message.index + 1]?.metadata.modality === "voice";
    if (before) return after ? "middle" : "end";
    return after ? "start" : "single";
  });

const SpokenText: TextMessagePartComponent = ({ text }: { text: string }) => (
  <p className={styles.spokenText}>{text}</p>
);

const SpokenMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const position = useVoiceRunPosition();
  const isSpeaking = useAuiState(
    (s) =>
      s.message.role === "assistant" && s.message.status?.type === "running",
  );
  const opensExchange = position === "start" || position === "single";

  return (
    <MessagePrimitive.Root
      data-slot="aui_spoken-message-root"
      data-role={role}
      data-voice-run={position}
      className={cx(
        "aui-spoken-message",
        styles.spokenMessage,
        position === "single" && styles.spokenSingle,
        position === "start" && styles.spokenStart,
        position === "middle" && styles.spokenMiddle,
        position === "end" && styles.spokenEnd,
      )}
    >
      {opensExchange && (
        <div
          data-slot="aui_spoken-exchange-header"
          className={styles.spokenExchangeHeader}
        >
          <PhoneIcon className={styles.spokenExchangeIcon} aria-hidden />
          <span>Voice conversation</span>
        </div>
      )}
      <div
        data-slot="aui_spoken-message-content"
        className={styles.spokenMessageContent}
      >
        <span className={styles.spokenRoleIconWrap} aria-hidden>
          {role === "user" ? (
            <MicIcon className={styles.spokenRoleIcon} />
          ) : (
            <AudioLinesIcon className={styles.spokenRoleIcon} />
          )}
        </span>
        <span className={a11y.srOnly}>
          {role === "user" ? "You said" : "Assistant said"}
        </span>
        <div className={styles.spokenTextWrap}>
          <MessagePrimitive.Parts components={{ Text: SpokenText }} />
          {isSpeaking && (
            <span
              data-slot="aui_spoken-message-indicator"
              role="status"
              className={styles.spokenIndicator}
              aria-label="Assistant is speaking"
            >
              ●
            </span>
          )}
        </div>
        <SpokenActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const SpokenActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="always"
      className={cx("aui-spoken-action-bar", styles.spokenActionBar)}
    >
      <ActionBarPrimitive.Copy
        render={
          <TooltipIconButton
            tooltip="Copy"
            className={styles.spokenCopyButton}
          />
        }
      >
        <AuiIf condition={(s) => s.message.isCopied}>
          <CheckIcon className={styles.copyIconCheck} />
        </AuiIf>
        <AuiIf condition={(s) => !s.message.isCopied}>
          <CopyIcon className={styles.copyIconCopy} />
        </AuiIf>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
};

const FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1']):not([disabled])";

const nextFocusable = (start: Element): HTMLElement | null => {
  for (
    let element = start.nextElementSibling;
    element;
    element = element.nextElementSibling
  ) {
    const target = element.matches(FOCUSABLE_SELECTOR)
      ? element
      : element.querySelector(FOCUSABLE_SELECTOR);
    if (target instanceof HTMLElement) return target;
  }
  return null;
};

const ThreadLoadEarlier: FC = () => {
  const visible = useAuiState(
    (s) => s.thread.hasEarlier || s.thread.isLoadingEarlier,
  );
  const loading = useAuiState((s) => s.thread.isLoadingEarlier);
  const slotRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<Element | null>(null);

  // The last page removes the button; a keyboard user on it continues from the
  // next control in tab order rather than from the document body.
  useLayoutEffect(() => {
    const focused = focusedRef.current;
    const slot = slotRef.current;
    if (visible || !focused || focused.isConnected || !slot) return;
    focusedRef.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    nextFocusable(slot)?.focus();
  }, [visible]);

  return (
    <div
      ref={slotRef}
      className={styles.loadEarlierSlot}
      onFocus={(event) => {
        focusedRef.current = event.target;
      }}
    >
      <span role="status" className={a11y.srOnly}>
        {loading ? "Loading earlier messages" : ""}
      </span>
      {visible && (
        <ThreadPrimitive.LoadEarlier
          render={
            <Button
              variant="subtle"
              size="compact-sm"
              radius="xl"
              data-slot="aui_thread-load-earlier"
              className={cx(
                "aui-thread-load-earlier",
                styles.loadEarlierButton,
              )}
            />
          }
        >
          <span className={loading ? "shimmer" : undefined}>
            {loading ? "Loading earlier messages" : "Load earlier messages"}
          </span>
        </ThreadPrimitive.LoadEarlier>
      )}
    </div>
  );
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom
      render={
        <TooltipIconButton
          tooltip="Scroll to bottom"
          className={cx("aui-thread-scroll-to-bottom", styles.scrollToBottom)}
        />
      }
    >
      <ArrowDownIcon />
    </ThreadPrimitive.ScrollToBottom>
  );
};

const WELCOME_VERBS = [
  "Abscond", // Leave secretly to avoid being caught.
  "Bloviate", // Speak at length with pompous confidence.
  "Caper", // Skip or dance about playfully.
  "Carouse", // Drink and party noisily with others.
  "Cavort", // Jump and dance around with excitement.
  "Dawdle", // Move slowly and waste time.
  "Dither", // Hesitate and struggle to decide.
  "Gallivant", // Roam about in pursuit of fun.
  "Galumph", // Move along heavily and clumsily.
  "Gambol", // Run and jump about playfully.
  "Malinger", // Fake being ill to avoid work.
  "Meander", // Wander along without a direct route.
  "Perambulate", // Walk around a place at leisure.
  "Pontificate", // Express opinions with pompous certainty.
  "Quibble", // Argue over small or trivial details.
  "Ruminate", // Think deeply and repeatedly about something.
  "Saunter", // Walk slowly in a relaxed manner.
  "Skulk", // Move stealthily to avoid being noticed.
  "Soliloquize", // Speak your thoughts aloud to yourself.
  "Traipse", // Walk about wearily or without purpose.
] as const;

const WELCOME_MODIFIERS = [
  "askance", // With a sideways or suspicious glance.
  "askew", // At an angle or out of alignment.
  "at an ungodly hour", // At an inconveniently early or late time.
  "betwixt two silences", // Between two moments of quiet.
  "beyond the pale", // Outside accepted standards of decent behavior.
  "by dubious means", // Using methods of questionable legitimacy.
  "contrariwise", // In the opposite way or direction.
  "in a borrowed hat", // Wearing a hat belonging to someone else.
  "in a minor key", // With a subdued or melancholy tone.
  "in dubious company", // Among people of questionable character.
  "obliquely", // At an angle or indirectly.
  "on a whim", // Following a sudden and unplanned impulse.
  "sideways at dusk", // Moving laterally as daylight fades.
  "sotto voce", // In a quiet or lowered voice.
  "in the small hours", // During the hours just after midnight.
  "under mild protest", // With some reluctance or objection.
  "with dubious aplomb", // With suspicious confidence and composure.
  "with undue gravitas", // With more solemnity than circumstances warrant.
  "with undue ceremony", // With excessive formality for the occasion.
  "without a map", // Without guidance or a clear direction.
] as const;

const pickWelcomeWord = (words: readonly string[]): string =>
  words[Math.floor(Math.random() * words.length)] ?? words[0];

const ThreadWelcome: FC = () => {
  const [verb] = useState(() => pickWelcomeWord(WELCOME_VERBS));
  const [modifier] = useState(() => pickWelcomeWord(WELCOME_MODIFIERS));
  const [line, setLine] = useState("...");

  useEffect(() => {
    let cancelled = false;
    void window.verbo.ollama
      .welcomeLine({ verb, modifier })
      .then((next) => {
        if (!cancelled && next) setLine(next);
      })
      .catch(() => {
        // Placeholder stays when the main process cannot reach Ollama.
      });
    return () => {
      cancelled = true;
    };
  }, [verb, modifier]);

  return (
    <div className={cx("aui-thread-welcome-root", styles.welcomeRoot)}>
      <h1
        className={cx(
          "aui-thread-welcome-message-inner",
          styles.welcomeMessageInner,
        )}
      >
        {verb} <em className={styles.welcomeEmphasis}>{modifier}.</em>
      </h1>
      <p className={styles.welcomeDescription}>{line}</p>
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div
      className={cx(
        "aui-thread-welcome-suggestions",
        styles.welcomeSuggestions,
      )}
    >
      {STARTER_PROMPTS.map(({ title, prompt, intent, Icon }) => (
        <ThreadPrimitive.Suggestion
          key={intent}
          prompt={prompt}
          send={false}
          render={
            <Button
              variant="subtle"
              radius="xl"
              className={styles.starterButton}
              data-intent={intent}
            />
          }
        >
          <Icon size={14} className={styles.starterIcon} aria-hidden="true" />
          {title}
          <ArrowUpRightIcon
            size={12}
            className={styles.starterArrow}
            aria-hidden="true"
          />
        </ThreadPrimitive.Suggestion>
      ))}
    </div>
  );
};

const STARTER_PROMPTS = [
  {
    title: "Explore an idea",
    prompt: "Help me explore an idea. Start by asking me what I have in mind.",
    intent: "explore",
    Icon: LightbulbIcon,
  },
  {
    title: "Create something",
    prompt:
      "I want to create something original. Ask me what I want to make, then help me find an unexpected direction.",
    intent: "create",
    Icon: SparklesIcon,
  },
  {
    title: "Challenge a belief",
    prompt:
      "Help me challenge a belief. Ask me what I believe, then offer the strongest thoughtful counterargument.",
    intent: "challenge",
    Icon: OrbitIcon,
  },
] as const;

const Composer: FC<{ autoFocus: boolean }> = ({ autoFocus }) => {
  return (
    <ComposerPrimitive.Root
      className={cx("aui-composer-root", styles.composerRoot)}
    >
      <ComposerPrimitive.AttachmentDropzone
        render={
          <div
            data-slot="aui_composer-shell"
            className={styles.composerShell}
          />
        }
      >
        <ComposerAttachments />
        <ComposerPrimitive.Input
          placeholder="What's on your mind?"
          className={cx("aui-composer-input", styles.composerInput)}
          rows={1}
          autoFocus={autoFocus}
          enterKeyHint="send"
          aria-label="Message input"
        />
        <ComposerAction />
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
  // The stop control only cancels the send while no run it could stop is going.
  const isSending = useAuiState(
    (s) =>
      s.composer.submission !== undefined &&
      !(s.thread.isRunning && s.thread.capabilities.cancel),
  );

  return (
    <div
      className={cx(
        "aui-composer-action-wrapper",
        styles.composerActionWrapper,
      )}
    >
      <AuiIf condition={(s) => s.thread.capabilities.attachments}>
        <ComposerAddAttachment />
      </AuiIf>
      <span className={styles.composerHint}>
        Enter to send <span aria-hidden="true">↵</span>
        <span className={styles.composerHintDetail}>
          {" "}
          · Shift + Enter for a new line
        </span>
      </span>
      <div className={styles.composerActions}>
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate
              render={
                <TooltipIconButton
                  tooltip="Voice input"
                  side="bottom"
                  type="button"
                  className={cx(
                    "aui-composer-dictate",
                    styles.composerIconButton,
                    styles.composerDictate,
                  )}
                  aria-label="Start voice input"
                />
              }
            >
              <MicIcon
                className={cx(
                  "aui-composer-dictate-icon",
                  styles.composerIconSm,
                )}
              />
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation
              render={
                <TooltipIconButton
                  tooltip="Stop dictation"
                  side="bottom"
                  type="button"
                  className={cx(
                    "aui-composer-stop-dictation",
                    styles.composerIconButton,
                    styles.composerStopDictate,
                  )}
                  aria-label="Stop voice input"
                />
              }
            >
              <SquareIcon
                className={cx(
                  "aui-composer-stop-dictation-icon",
                  styles.composerIconMd,
                  styles.composerStopIcon,
                )}
              />
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <AuiIf
          condition={(s) =>
            !s.composer.canCancel ||
            (s.thread.voice !== undefined &&
              s.composer.submission === undefined)
          }
        >
          <ComposerPrimitive.Send
            render={
              <TooltipIconButton
                tooltip="Send message"
                side="bottom"
                type="button"
                className={cx(
                  "aui-composer-send",
                  styles.composerIconButton,
                  styles.composerSend,
                )}
                aria-label="Send message"
              />
            }
          >
            <ArrowUpIcon
              className={cx("aui-composer-send-icon", styles.composerIconSm)}
            />
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf
          condition={(s) =>
            s.composer.canCancel &&
            (s.thread.voice === undefined ||
              s.composer.submission !== undefined)
          }
        >
          <ComposerPrimitive.Cancel
            render={
              <ActionIcon
                type="button"
                variant="subtle"
                className={cx(
                  "aui-composer-cancel",
                  styles.composerIconButton,
                  styles.composerCancel,
                )}
                aria-label={isSending ? "Cancel sending" : "Stop generating"}
              />
            }
          >
            <SquareIcon
              className={cx(
                "aui-composer-cancel-icon",
                styles.composerIconMd,
                styles.composerCancelIcon,
              )}
            />
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root
        className={cx("aui-message-error-root", styles.messageErrorRoot)}
      >
        <ErrorPrimitive.Message
          className={cx(
            "aui-message-error-message",
            styles.messageErrorMessage,
          )}
        />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
    TaskGroup: TaskGroupComponent,
  } = useContext(ThreadComponentsContext);
  const groupBy = TaskGroupComponent ? taskAwareGroupBy : messageGroupBy;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className={styles.assistantMessageRoot}
    >
      <div
        data-slot="aui_assistant-message-content"
        className={styles.assistantMessageContent}
      >
        <MessagePrimitive.GroupedParts groupBy={groupBy}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-task":
                return TaskGroupComponent ? (
                  <TaskGroupComponent group={part} />
                ) : null;
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger
                      active={running}
                      duration={reasoningDuration(part.timing)}
                    />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data":
                return part.dataRendererUI;
              case "file":
                return (
                  <div
                    data-slot="aui_assistant-message-file"
                    className={styles.partPadding}
                  >
                    <MessageFile {...part} />
                  </div>
                );
              case "image":
                return (
                  <div
                    data-slot="aui_assistant-message-image"
                    className={styles.partPadding}
                  >
                    <Image {...part} />
                  </div>
                );
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className={styles.workingIndicator}
                    aria-label="Assistant is working"
                  >
                    {"●"}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={styles.assistantFooter}
      >
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className={cx("aui-assistant-action-bar-root", styles.assistantActionBar)}
    >
      <ActionBarPrimitive.Copy render={<TooltipIconButton tooltip="Copy" />}>
        <AuiIf condition={(s) => s.message.isCopied}>
          <CheckIcon className={styles.copyIconCheck} />
        </AuiIf>
        <AuiIf condition={(s) => !s.message.isCopied}>
          <CopyIcon className={styles.copyIconCopy} />
        </AuiIf>
      </ActionBarPrimitive.Copy>
      <AuiIf condition={(s) => s.thread.capabilities.feedback}>
        <ActionBarPrimitive.FeedbackPositive
          render={
            <TooltipIconButton
              tooltip="Helpful"
              className={styles.feedbackButton}
            />
          }
        >
          <ThumbsUpIcon />
        </ActionBarPrimitive.FeedbackPositive>
        <ActionBarPrimitive.FeedbackNegative
          render={
            <TooltipIconButton
              tooltip="Not helpful"
              className={styles.feedbackButton}
            />
          }
        >
          <ThumbsDownIcon />
        </ActionBarPrimitive.FeedbackNegative>
      </AuiIf>
      <ActionBarPrimitive.Reload
        render={<TooltipIconButton tooltip="Refresh" />}
      >
        <RefreshCwIcon />
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger
          render={
            <TooltipIconButton tooltip="More" className={styles.moreTrigger} />
          }
        >
          <MoreHorizontalIcon />
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className={cx(
            "aui-action-bar-more-content",
            styles.actionBarMoreContent,
          )}
        >
          <ActionBarPrimitive.ExportMarkdown
            render={
              <ActionBarMorePrimitive.Item
                className={cx(
                  "aui-action-bar-more-item",
                  styles.actionBarMoreItem,
                )}
              />
            }
          >
            <DownloadIcon className={styles.iconSize4} />
            Export as Markdown
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const MessageFile: FileMessagePartComponent = (part) => {
  const image = part.mimeType.toLowerCase().startsWith("image/")
    ? getFileHref(part.data, part.mimeType, part.sourceType)
    : null;
  if (!image) return <File {...part} />;
  return (
    <Image
      type="image"
      image={image}
      status={part.status}
      {...(part.filename !== undefined && { filename: part.filename })}
    />
  );
};

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className={styles.partPadding}>
    <MessageFile {...part} />
  </div>
);

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className={styles.partPadding}>
    <Image {...part} />
  </div>
);

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className={styles.userMessageRoot}
      data-role="user"
    >
      <UserMessageAttachments />

      <div
        className={cx(
          "aui-user-message-content-wrapper",
          styles.userContentWrapper,
        )}
      >
        <div
          className={cx("aui-user-message-content", styles.userMessageContent)}
        >
          <MessagePrimitive.Parts
            components={{ File: UserFilePart, Image: UserImagePart }}
          />
        </div>
        <div
          className={cx(
            "aui-user-action-bar-wrapper",
            styles.userActionBarWrapper,
          )}
        >
          <UserActionBar />
        </div>
      </div>

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className={styles.userBranchPicker}
      />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className={cx("aui-user-action-bar-root", styles.userActionBarRoot)}
    >
      <ActionBarPrimitive.Edit
        render={
          <TooltipIconButton tooltip="Edit" className="aui-user-action-edit" />
        }
      >
        <PencilIcon />
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className={styles.editComposerWrapper}
    >
      <ComposerPrimitive.Root
        className={cx("aui-edit-composer-root", styles.editComposerRoot)}
      >
        <ComposerPrimitive.Input
          className={cx("aui-edit-composer-input", styles.editComposerInput)}
          autoFocus
        />
        <div
          className={cx("aui-edit-composer-footer", styles.editComposerFooter)}
        >
          <ComposerPrimitive.Cancel
            render={
              <Button
                variant="subtle"
                size="compact-sm"
                className={styles.editComposerButton}
              />
            }
          >
            Cancel
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send
            render={
              <Button
                variant="filled"
                size="compact-sm"
                className={styles.editComposerButton}
              />
            }
          >
            Update
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cx(
        "aui-branch-picker-root",
        styles.branchPickerRoot,
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous
        render={<TooltipIconButton tooltip="Previous" />}
      >
        <ChevronLeftIcon />
      </BranchPickerPrimitive.Previous>
      <span className={cx("aui-branch-picker-state", styles.branchPickerState)}>
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next render={<TooltipIconButton tooltip="Next" />}>
        <ChevronRightIcon />
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
