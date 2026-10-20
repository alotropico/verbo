"use client";

import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "@/components/assistant-ui/elements/attachment.aui";
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
import { BackendNotice, FinalizationNotice } from "@/components/BackendNotice";
import { CommandNotice } from "@/components/CommandNotice";
import { ContextMeters } from "@/components/ContextMeters";
import { QueueRows } from "@/components/QueueSidebar";
import { StatusMessage } from "@/components/StatusMessage";
import { useVoiceListening } from "@/components/voice-session-context";
import {
  VoiceDraftPanel,
  VoiceOrb,
  VoiceSessionButton,
} from "@/components/VoiceSession";
import {
  WorkflowRoutingNotice,
  WorkflowStageNotice,
} from "@/components/WorkflowProgress";
import a11y from "@/lib/a11y.module.css";
import { cx } from "@/lib/cx";
import { copyText } from "@/lib/clipboard";
import { CHAT_TRANSFER_ACTIONS, transferChat } from "@/lib/chat-transfer";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useAdvancedExport } from "@/runtime/advanced-export";
import { approvalStaysOutsideGroups } from "@/runtime/approval-notice";
import {
  interactionJson,
  readThreadInteraction,
  subscribeLatestExchange,
} from "@/runtime/latest-exchange";
import { getQueueEdit, subscribeQueueEdit } from "@/runtime/queue-edit";
import { noteThreadActivity, timestampMs } from "@/runtime/thread-activity";
import { useLocalCommandGuard } from "@/runtime/use-local-command";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  type AssistantState,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import {
  ActionIcon,
  Button,
  Menu,
  Skeleton,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  exportMessageRecord,
  messageExportJson,
  type ChatExport,
} from "@shared/chat-export";
import { USER_ABORT_NOTICE } from "@shared/chat-ipc";
import { chatPlaceholderTitle } from "@shared/thread-title";
import { isPendingApprovalResult } from "@shared/tool-result-label";
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
  OrbitIcon,
  PencilIcon,
  PhoneIcon,
  RefreshCwIcon,
  SparklesIcon,
  SquareIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XIcon,
} from "lucide-react";
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type FC,
  type PropsWithChildren,
} from "react";
import { ApprovalRequests } from "./approval-region";
import { ExecutionTraceView, useMessageTrace } from "./execution-trace-view";
import { ThreadFollowupSuggestions } from "./follow-up-suggestions.aui";
import { MessageTime } from "./message-time";
import { PendingIndicator } from "./pending-indicator";
import { SpeechSyncedText } from "./speech-synced-text";
import styles from "./thread.module.css";
import { TooltipIconButton } from "./tooltip-icon-button";
import { TouchedFiles } from "./touched-files";

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

const ThreadActivitySync: FC = () => {
  const stamp = useAuiState((s) => {
    let count = 0;
    let at = 0;
    for (const message of s.thread.messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      count += 1;
      const time = timestampMs(message.createdAt);
      if (time > at) at = time;
    }
    if (count === 0) return "";
    return `${s.threads.mainThreadId}\n${count}\n${at}`;
  });

  useEffect(() => {
    if (!stamp) return;
    const [threadId, countText, atText] = stamp.split("\n");
    if (!threadId || !countText || !atText) return;
    noteThreadActivity(threadId, Number(atText), Number(countText));
  }, [stamp]);

  return null;
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
      <ThreadActivitySync />
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
            <VoiceDraftPanel />
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cx(
              "aui-thread-viewport-footer",
              styles.viewportFooter,
              !isEmpty && styles.viewportFooterDocked,
            )}
          >
            {!isEmpty && <div aria-hidden className={styles.threadFade} />}
            <ThreadFollowupSuggestions />
            <CommandNotice />
            <div className={styles.composerBlock}>
              <QueueRows />
              <VoiceOrb />
              <Composer autoFocus={autoFocus} />
              <div className={styles.composerMeta}>
                <ContextMeters />
                <ComposerChatMenu />
              </div>
            </div>
            <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
      <ThreadScrollToBottom />
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

const SpokenText: TextMessagePartComponent = () => <SpeechSyncedText plain />;

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

const MessageCopyButton: FC<{ className?: string }> = ({ className }) => {
  const messageId = useAuiState((state) => state.message.id);
  return <MessageCopyControl key={messageId} className={className} />;
};

const MessageCopyControl: FC<{ className?: string }> = ({ className }) => {
  const advanced = useAdvancedExport();
  const aui = useAui();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const running = useAuiState(
    (state) =>
      state.message.role === "assistant" &&
      state.message.status?.type === "running",
  );
  const copy = (): void => {
    if (running) return;
    const message = aui.message().getState();
    const threadId = aui.threads().getState().mainThreadId;
    const composer = aui.composer().getState();
    const text = advanced
      ? messageExportJson(message, readThreadInteraction(threadId))
      : composer.isEditing
        ? composer.text
        : aui.message().getCopyText();
    copyToClipboard(text);
  };
  return (
    <TooltipIconButton
      tooltip={advanced ? "Copy objects" : "Copy"}
      className={className}
      disabled={running}
      onClick={copy}
    >
      {isCopied ? (
        <CheckIcon className={styles.copyIconCheck} size={14} />
      ) : (
        <CopyIcon className={styles.copyIconCopy} size={14} />
      )}
    </TooltipIconButton>
  );
};

const SpokenActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      autohide="always"
      className={cx("aui-spoken-action-bar", styles.spokenActionBar)}
    >
      <MessageTime />
      <MessageCopyButton className={styles.spokenCopyButton} />
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

type WelcomePart = { readonly word: string; readonly gloss: string };

const WELCOME_VERBS: readonly WelcomePart[] = [
  { word: "Abscond", gloss: "Leave secretly to avoid being caught." },
  { word: "Amble", gloss: "Walk slowly in an easygoing manner." },
  { word: "Aurify", gloss: "Turn a base material into radiant gold." },
  { word: "Bedazzle", gloss: "Blind or charm completely with intense brightness." },
  { word: "Beguile", gloss: "Charm or enchant someone, sometimes deceptively." },
  { word: "Besmear", gloss: "Coarse or smear a surface softly with color." },
  { word: "Bewilder", gloss: "Cause someone to feel completely lost or perplexed." },
  { word: "Bloviate", gloss: "Speak at length with pompous confidence." },
  { word: "Bumble", gloss: "Move about clumsily or without purpose." },
  { word: "Caper", gloss: "Skip or dance about playfully." },
  { word: "Carouse", gloss: "Drink and party noisily with others." },
  { word: "Cavort", gloss: "Jump and dance around with excitement." },
  { word: "Chortle", gloss: "Laugh with cheerful, barely contained delight." },
  { word: "Dawdle", gloss: "Move slowly and waste time." },
  { word: "Deliquesce", gloss: "Melt away gently into a liquid state." },
  { word: "Dissemble", gloss: "Conceal your true motives or feelings." },
  { word: "Dither", gloss: "Hesitate and struggle to decide." },
  { word: "Faff", gloss: "Waste time on unnecessary little tasks." },
  { word: "Flounder", gloss: "Struggle clumsily to make any progress." },
  { word: "Frolic", gloss: "Play or move about with exuberance." },
  { word: "Gallivant", gloss: "Roam about in pursuit of fun." },
  { word: "Galumph", gloss: "Move along heavily and clumsily." },
  { word: "Gambol", gloss: "Run and jump about playfully." },
  { word: "Gesticulate", gloss: "Use expressive gestures while speaking excitedly." },
  { word: "Lollygag", gloss: "Spend time idly without doing much." },
  { word: "Maculate", gloss: "Stain or spot with dark, delicate flecks." },
  { word: "Malinger", gloss: "Fake being ill to avoid work." },
  { word: "Maunder", gloss: "Talk or wander without clear direction." },
  { word: "Meander", gloss: "Wander along without a direct route." },
  { word: "Natter", gloss: "Chat at length about trivial things." },
  { word: "Opalesce", gloss: "Glimmer softly with a milky, shifting sheen." },
  { word: "Perambulate", gloss: "Walk around a place at leisure." },
  { word: "Phosphoresce", gloss: "Glow in the dark without producing any heat." },
  { word: "Plume", gloss: "Rise or spread out like a soft feather." },
  { word: "Pontificate", gloss: "Express opinions with pompous certainty." },
  { word: "Pootle", gloss: "Move about leisurely without much purpose." },
  { word: "Quibble", gloss: "Argue over small or trivial details." },
  { word: "Ruminate", gloss: "Think deeply and repeatedly about something." },
  { word: "Saunter", gloss: "Walk slowly in a relaxed manner." },
  { word: "Scintillate", gloss: "Sparkle or flash brilliantly with bright light." },
  { word: "Shamble", gloss: "Walk awkwardly with slow, dragging steps." },
  { word: "Simper", gloss: "Smile in a coy, affected manner." },
  { word: "Skulk", gloss: "Move stealthily to avoid being noticed." },
  { word: "Soliloquize", gloss: "Speak your thoughts aloud to yourself." },
  { word: "Swagger", gloss: "Walk with conspicuous confidence or arrogance." },
  { word: "Tarry", gloss: "Stay longer or delay your departure." },
  { word: "Traipse", gloss: "Walk about wearily or without purpose." },
  { word: "Transfuse", gloss: "Pour a liquid or quality gently into another." },
  { word: "Waddle", gloss: "Walk with short steps, swaying sideways." },
  { word: "Waffle", gloss: "Talk vaguely without reaching a conclusion." },
  { word: "Witter", gloss: "Talk endlessly about unimportant little things." },
  { word: "Yodel", gloss: "Sing while rapidly changing vocal registers." },
];

const WELCOME_MODIFIERS: readonly WelcomePart[] = [
  { word: "askance", gloss: "With a sideways or suspicious glance." },
  { word: "askew", gloss: "At an angle or poorly aligned." },
  { word: "at an odd hour", gloss: "At an unusual or inconvenient time." },
  { word: "betwixt hushes", gloss: "Between two moments of quiet." },
  {
    word: "beyond the pale",
    gloss: "Outside accepted standards of decent behavior.",
  },
  {
    word: "by shady means",
    gloss: "Using methods of questionable legitimacy.",
  },
  { word: "contrariwise", gloss: "In the opposite way or direction." },
  {
    word: "in a loaned hat",
    gloss: "Wearing a hat belonging to someone else.",
  },
  { word: "in a minor key", gloss: "With a subdued or melancholy tone." },
  { word: "among rogues", gloss: "Among people of questionable character." },
  { word: "obliquely", gloss: "At an angle or indirectly." },
  { word: "on a whim", gloss: "Following a sudden and unplanned impulse." },
  { word: "sidling at dusk", gloss: "Moving sideways as daylight fades." },
  { word: "sotto voce", gloss: "In a quiet or lowered voice." },
  { word: "in wee hours", gloss: "During the hours just after midnight." },
  { word: "under protest", gloss: "With some reluctance or objection." },
  { word: "with sly aplomb", gloss: "With crafty confidence and composure." },
  { word: "with gravitas", gloss: "With an air of solemn importance." },
  {
    word: "ceremoniously",
    gloss: "With elaborate formality for the occasion.",
  },
  { word: "without a map", gloss: "Without guidance or a clear direction." },
  {
    word: "against custom",
    gloss: "Contrary to prevailing habits or expectations.",
  },
  {
    word: "amid the hubbub",
    gloss: "Surrounded by noisy activity and chatter.",
  },
  { word: "as fate permits", gloss: "As circumstances or chance will allow." },
  { word: "rakishly askew", gloss: "Tilted with a jaunty, mischievous air." },
  { word: "by candlelight", gloss: "Illuminated by the glow of candles." },
  {
    word: "for odd reasons",
    gloss: "For peculiar or hard-to-explain motives.",
  },
  {
    word: "in a fake beard",
    gloss: "Wearing an unconvincing disguise on your chin.",
  },
  { word: "in a pique", gloss: "During a sudden burst of irritation." },
  {
    word: "amid misgivings",
    gloss: "With uncertainty clouding your thoughts.",
  },
  {
    word: "in full plumage",
    gloss: "Dressed elaborately to attract admiring attention.",
  },
  {
    word: "in high dudgeon",
    gloss: "With pronounced indignation or offended pride.",
  },
  { word: "in odd socks", gloss: "Wearing socks that do not match." },
  {
    word: "in shady haste",
    gloss: "With urgency that raises awkward questions.",
  },
  {
    word: "past the bell",
    gloss: "Beyond the expected or permitted duration.",
  },
  { word: "under an alias", gloss: "While pretending to be someone else." },
  {
    word: "with a sly grin",
    gloss: "With a knowing, slightly mischievous smile.",
  },
  { word: "with faux poise", gloss: "With composure that is merely an act." },
  {
    word: "with mock pomp",
    gloss: "With exaggerated ceremony intended as a joke.",
  },
  { word: "with panache", gloss: "With striking style and confident flair." },
  {
    word: "without fanfare",
    gloss: "Without ceremony, publicity, or special attention.",
  },
];

const pickWelcomePart = (parts: readonly WelcomePart[]): WelcomePart =>
  parts[Math.floor(Math.random() * parts.length)] ?? parts[0]!;

const ThreadWelcome: FC = () => {
  const [verb] = useState(() => pickWelcomePart(WELCOME_VERBS));
  const [modifier] = useState(() => pickWelcomePart(WELCOME_MODIFIERS));
  const [line, setLine] = useState<string | null>(null);
  const [linePending, setLinePending] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void window.verbo.ollama
      .welcomeLine({ verb: verb.word, modifier: modifier.word })
      .then((next) => {
        if (!cancelled && next) setLine(next);
      })
      .catch(() => {
        // Dots stop when the main process cannot reach Ollama.
      })
      .finally(() => {
        if (!cancelled) setLinePending(false);
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
        <Tooltip label={verb.gloss} multiline maw={280}>
          <span>{verb.word}</span>
        </Tooltip>{" "}
        <Tooltip label={modifier.gloss} multiline maw={280}>
          <em className={styles.welcomeEmphasis}>{modifier.word}</em>
        </Tooltip>{" "}
      </h1>
      <p className={styles.welcomeDescription}>
        {line ??
          (linePending ? (
            <PendingIndicator label="Writing a line" size="compact" />
          ) : null)}
      </p>
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

type VisibleChatMessage = {
  id: string;
  role: string;
  content: readonly unknown[];
  attachments?: readonly { content?: readonly unknown[] }[];
};

function visibleChatExport(
  id: string,
  title: string,
  messages: readonly VisibleChatMessage[],
): ChatExport | null {
  const visible = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (visible.length === 0) return null;
  return {
    id,
    title,
    headId: visible.at(-1)?.id ?? null,
    messages: visible.map((message, index) => {
      const parentId = index === 0 ? null : (visible[index - 1]?.id ?? null);
      const record = exportMessageRecord(message) ?? {};
      return {
        ...record,
        id: message.id,
        parentId,
        role: message.role,
        content: record.content ?? message.content,
      };
    }),
  };
}

const ComposerChatMenu: FC = () => {
  const aui = useAui();
  const hasChat = useAuiState((state) =>
    state.thread.messages.some(
      (message) => message.role === "user" || message.role === "assistant",
    ),
  );
  if (!hasChat) return null;
  return (
    <Menu position="top-end" offset={6} withinPortal>
      <Menu.Target>
        <TooltipIconButton
          tooltip="Chat actions"
          type="button"
          className={styles.composerMetaTrigger}
          aria-label="Chat actions"
        >
          <MoreHorizontalIcon size={12} />
        </TooltipIconButton>
      </Menu.Target>
      <Menu.Dropdown className={styles.composerMenu}>
        {CHAT_TRANSFER_ACTIONS.map((action) => (
          <Menu.Item
            key={action.id}
            className={styles.composerMenuItem}
            leftSection={
              action.mode === "copy" ? (
                <CopyIcon className={styles.iconSize4} />
              ) : (
                <DownloadIcon className={styles.iconSize4} />
              )
            }
            onClick={() => {
              const thread = aui.thread().getState();
              const threads = aui.threads().getState();
              const title =
                threads.threadItems.find(
                  (item) => item.id === threads.mainThreadId,
                )?.title || chatPlaceholderTitle(threads.mainThreadId);
              const chat = visibleChatExport(
                threads.mainThreadId,
                title,
                thread.messages,
              );
              if (chat)
                transferChat(
                  chat,
                  action,
                  readThreadInteraction(threads.mainThreadId),
                );
            }}
          >
            {action.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
};

const Composer: FC<{ autoFocus: boolean }> = ({ autoFocus }) => {
  const command = useLocalCommandGuard();
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const editing = useSyncExternalStore(subscribeQueueEdit, () =>
    getQueueEdit(threadId),
  );
  return (
    <ComposerPrimitive.Root
      className={cx("aui-composer-root", styles.composerRoot)}
      onSubmit={command.onSubmit}
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
        {editing?.attachmentRefs.length ? (
          <Text size="xs" c="dimmed" aria-label="Queued attachments">
            Queued attachments:{" "}
            {editing.attachmentRefs.map((ref) => ref.name).join(", ")}
          </Text>
        ) : null}
        <ComposerPrimitive.Input
          placeholder="What's on your mind?"
          className={cx("aui-composer-input", styles.composerInput)}
          rows={1}
          autoFocus={autoFocus}
          enterKeyHint="send"
          aria-label="Message input"
          onKeyDown={command.onKeyDown}
        />
        <ComposerAction
          canSend={command.canSend}
          onSend={command.sendOrCommand}
          onCancelEdit={command.cancelQueueEdit}
        />
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC<{
  canSend: boolean;
  onSend: () => void;
  onCancelEdit: () => void;
}> = ({ canSend, onSend, onCancelEdit }) => {
  const listening = useVoiceListening();
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const editing = useSyncExternalStore(
    subscribeQueueEdit,
    () => getQueueEdit(threadId),
    () => getQueueEdit(threadId),
  );
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
      <div className={styles.composerActions}>
        {editing ? (
          <TooltipIconButton
            tooltip="Cancel queue edit"
            type="button"
            aria-label="Cancel queue edit"
            className={styles.composerIconButton}
            onClick={onCancelEdit}
          >
            <XIcon className={styles.composerIconSm} />
          </TooltipIconButton>
        ) : null}
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
        <TooltipIconButton
          tooltip={editing ? "Save changes" : "Send message"}
          side="bottom"
          type="button"
          className={cx(
            "aui-composer-send",
            styles.composerIconButton,
            styles.composerSend,
          )}
          aria-label={editing ? "Save changes" : "Send message"}
          disabled={!canSend}
          onClick={onSend}
        >
          <ArrowUpIcon
            className={cx("aui-composer-send-icon", styles.composerIconSm)}
          />
        </TooltipIconButton>
        <VoiceSessionButton />
        {listening ? null : (
          <AuiIf condition={(s) => s.composer.canCancel}>
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
                  onClick={() => {
                    void window.verbo.turns.cancel();
                  }}
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
        )}
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
        <StatusMessage display="outline" role={false} size="sm" tone="error">
          <ErrorPrimitive.Message
            className={cx(
              "aui-message-error-message",
              styles.messageErrorMessage,
            )}
          />
        </StatusMessage>
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const DefaultToolGroup: FC<
  PropsWithChildren<{ count: number; active: boolean }>
> = ({ count, active, children }) => {
  const pending = useAuiState((state) =>
    state.message.content.some(
      (part) =>
        part.type === "tool-call" && isPendingApprovalResult(part.result),
    ),
  );
  const [open, setOpen] = useState(pending);
  const [previousPending, setPreviousPending] = useState(pending);
  if (pending !== previousPending) {
    setPreviousPending(pending);
    if (pending) setOpen(true);
  }
  return (
    <ToolGroupRoot variant="ghost" open={open} onOpenChange={setOpen}>
      <ToolGroupTrigger count={count} active={active} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
    TaskGroup: TaskGroupComponent,
  } = useContext(ThreadComponentsContext);
  const groupBy = (
    part: Parameters<typeof messageGroupBy>[0],
    context?: Parameters<typeof messageGroupBy>[1],
  ): readonly ThreadGroupKey[] =>
    approvalStaysOutsideGroups(part)
      ? []
      : TaskGroupComponent
        ? taskAwareGroupBy(part, context)
        : messageGroupBy(part, context);
  const status = useAuiState((state) => state.message.status?.type);
  const parts = useAuiState((state) => state.message.parts);
  const trace = useMessageTrace();
  const pendingApproval = useAuiState((state) =>
    state.message.content.some(
      (part) =>
        part.type === "tool-call" && isPendingApprovalResult(part.result),
    ),
  );
  const ready = trace?.readiness === "ready" || status !== "running";
  const ApprovalBoundary = trace ? Fragment : ApprovalRequests;

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
        <ApprovalBoundary>
          {trace ? (
            <ExecutionTraceView
              trace={trace}
              active={status === "running"}
              renderCall={(node) => {
                const index = parts.findIndex(
                  (part) =>
                    part.type === "tool-call" &&
                    part.toolCallId === node.correlation?.toolCallId,
                );
                return index < 0 ? null : (
                  <MessagePrimitive.PartByIndex
                    index={index}
                    components={{ tools: { Fallback: ToolFallbackComponent } }}
                  />
                );
              }}
            />
          ) : null}
          <MessagePrimitive.GroupedParts groupBy={groupBy}>
            {({ part, children }) => {
              switch (part.type) {
                case "group-chainOfThought":
                  if (!ready) return null;
                  return <div data-slot="aui_chain-of-thought">{children}</div>;
                case "group-task":
                  if (!ready) return null;
                  return TaskGroupComponent ? (
                    <TaskGroupComponent group={part} />
                  ) : null;
                case "group-tool":
                  if (trace) return <></>;
                  if (!ready && !pendingApproval) return null;
                  if (ToolGroup) {
                    return <ToolGroup group={part}>{children}</ToolGroup>;
                  }
                  return (
                    <DefaultToolGroup
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    >
                      {children}
                    </DefaultToolGroup>
                  );
                case "group-reasoning": {
                  if (!ready) return null;
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
                  if (!ready) return null;
                  return part.text === USER_ABORT_NOTICE ? (
                    <StatusMessage display="plain" size="sm" tone="warning">
                      {USER_ABORT_NOTICE}
                    </StatusMessage>
                  ) : (
                    <SpeechSyncedText />
                  );
                case "reasoning":
                  if (!ready) return null;
                  return <Reasoning {...part} />;
                case "tool-call":
                  if (trace) return <></>;
                  if (!ready && !approvalStaysOutsideGroups(part)) return null;
                  return part.toolUI ?? <ToolFallbackComponent {...part} />;
                case "data":
                  if (part.name === "execution-trace") return null;
                  if (part.name === "workflow-execution") return null;
                  if (part.name === "workflow-stage")
                    return trace ? null : (
                      <WorkflowStageNotice data={part.data} />
                    );
                  if (part.name === "routing-stage")
                    return trace ? null : (
                      <WorkflowRoutingNotice data={part.data} />
                    );
                  if (part.name === "finalization")
                    return <FinalizationNotice data={part.data} />;
                  if (!ready) return null;
                  return part.name === "backend-notice" ? (
                    <BackendNotice data={part.data} />
                  ) : (
                    part.dataRendererUI
                  );
                case "file":
                case "image":
                  return <></>;
                case "indicator":
                  return <></>;
                default:
                  return null;
              }
            }}
          </MessagePrimitive.GroupedParts>
        </ApprovalBoundary>
        <MessageError />
        {ready ? <TouchedFiles /> : null}
        {status === "running" ? (
          <div
            data-slot="aui_assistant-message-indicator"
            className={styles.workingIndicator}
          >
            <PendingIndicator label="Awaiting completion" />
          </div>
        ) : null}
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

function downloadText(
  filename: string,
  text: string,
  mime = "application/json",
): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 40_000);
}

const MessageExportItem: FC = () => {
  const advanced = useAdvancedExport();
  const aui = useAui();
  const itemClass = cx("aui-action-bar-more-item", styles.actionBarMoreItem);
  if (!advanced) {
    return (
      <ActionBarPrimitive.ExportMarkdown
        render={<ActionBarMorePrimitive.Item className={itemClass} />}
      >
        <DownloadIcon className={styles.iconSize4} />
        Export as Markdown
      </ActionBarPrimitive.ExportMarkdown>
    );
  }
  return (
    <ActionBarMorePrimitive.Item
      className={itemClass}
      onClick={() => {
        const message = aui.message().getState();
        const threadId = aui.threads().getState().mainThreadId;
        downloadText(
          `message-${message.id}.json`,
          messageExportJson(message, readThreadInteraction(threadId)),
          "application/json",
        );
      }}
    >
      <DownloadIcon className={styles.iconSize4} />
      Export objects
    </ActionBarMorePrimitive.Item>
  );
};

const AssistantActionBar: FC = () => {
  const messageId = useAuiState((state) => state.message.id);
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const isLast = useAuiState(
    (state) => state.message.index === state.thread.messages.length - 1,
  );
  const interaction = useSyncExternalStore(
    subscribeLatestExchange,
    () => readThreadInteraction(threadId),
    () => null,
  );
  const exchange =
    isLast && interaction?.assistantMessageId === messageId
      ? interaction
      : null;
  const copyInteraction = (): void => {
    const text = interactionJson(threadId);
    if (!text) return;
    void copyText(text);
  };
  const downloadInteraction = (): void => {
    const text = interactionJson(threadId);
    if (!text || !exchange) return;
    downloadText(`interaction-${exchange.assistantMessageId}.json`, text);
  };
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className={cx("aui-assistant-action-bar-root", styles.assistantActionBar)}
    >
      <MessageTime />
      <MessageCopyButton className={styles.compactAction} />
      <AuiIf condition={(s) => s.thread.capabilities.feedback}>
        <ActionBarPrimitive.FeedbackPositive
          render={
            <TooltipIconButton
              tooltip="Helpful"
              className={cx(styles.feedbackButton, styles.compactAction)}
            />
          }
        >
          <ThumbsUpIcon size={14} />
        </ActionBarPrimitive.FeedbackPositive>
        <ActionBarPrimitive.FeedbackNegative
          render={
            <TooltipIconButton
              tooltip="Not helpful"
              className={cx(styles.feedbackButton, styles.compactAction)}
            />
          }
        >
          <ThumbsDownIcon size={14} />
        </ActionBarPrimitive.FeedbackNegative>
      </AuiIf>
      <ActionBarPrimitive.Reload
        render={
          <TooltipIconButton
            tooltip="Refresh"
            className={styles.compactAction}
          />
        }
      >
        <RefreshCwIcon size={14} />
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger
          render={
            <TooltipIconButton
              tooltip="More"
              className={cx(styles.moreTrigger, styles.compactAction)}
            />
          }
        >
          <MoreHorizontalIcon size={14} />
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
          <MessageExportItem />
          {exchange ? (
            <ActionBarMorePrimitive.Item
              className={cx(
                "aui-action-bar-more-item",
                styles.actionBarMoreItem,
              )}
              onClick={copyInteraction}
            >
              <CopyIcon className={styles.iconSize4} />
              Copy interaction
            </ActionBarMorePrimitive.Item>
          ) : null}
          {exchange ? (
            <ActionBarMorePrimitive.Item
              className={cx(
                "aui-action-bar-more-item",
                styles.actionBarMoreItem,
              )}
              onClick={downloadInteraction}
            >
              <DownloadIcon className={styles.iconSize4} />
              Download interaction
            </ActionBarMorePrimitive.Item>
          ) : null}
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const CollapsibleUserText: TextMessagePartComponent = ({ text }) => {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const node = useRef<HTMLDivElement | null>(null);
  const id = useId();
  useLayoutEffect(() => {
    const element = node.current;
    if (!element) return undefined;
    const measure = (): void =>
      setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  const toggle = (): void => {
    if (!window.getSelection()?.toString() && (overflowing || expanded))
      setExpanded((value) => !value);
  };
  return (
    <>
      <div
        id={id}
        ref={node}
        className={cx(styles.userText, !expanded && styles.userTextClamped)}
        role={overflowing || expanded ? "button" : undefined}
        tabIndex={overflowing || expanded ? 0 : undefined}
        aria-expanded={overflowing || expanded ? expanded : undefined}
        onClick={toggle}
        onKeyDown={(event) => {
          if (
            (event.key === "Enter" || event.key === " ") &&
            (overflowing || expanded)
          ) {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        }}
      >
        {text}
      </div>
      {overflowing || expanded ? (
        <Button
          type="button"
          size="compact-xs"
          variant="subtle"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show full message"}
        </Button>
      ) : null}
    </>
  );
};

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
          <MessagePrimitive.Parts>
            {({ part }) =>
              part.type === "text" ? <CollapsibleUserText {...part} /> : <></>
            }
          </MessagePrimitive.Parts>
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
      autohide="not-last"
      className={cx("aui-user-action-bar-root", styles.userActionBarRoot)}
    >
      <MessageTime />
      <MessageCopyButton className={styles.compactAction} />
      <ActionBarPrimitive.Edit
        render={
          <TooltipIconButton
            tooltip="Edit"
            className={cx("aui-user-action-edit", styles.compactAction)}
          />
        }
      >
        <PencilIcon size={14} />
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  const command = useLocalCommandGuard();
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className={styles.editComposerWrapper}
    >
      <ComposerPrimitive.Root
        className={cx("aui-edit-composer-root", styles.editComposerRoot)}
        onSubmit={command.onSubmit}
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
          <Button
            variant="filled"
            size="compact-sm"
            type="button"
            className={styles.editComposerButton}
            disabled={!command.canSend}
            onClick={command.sendOrCommand}
          >
            Update
          </Button>
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
        render={
          <TooltipIconButton
            tooltip="Previous"
            className={styles.compactAction}
          />
        }
      >
        <ChevronLeftIcon size={14} />
      </BranchPickerPrimitive.Previous>
      <span className={cx("aui-branch-picker-state", styles.branchPickerState)}>
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next
        render={
          <TooltipIconButton tooltip="Next" className={styles.compactAction} />
        }
      >
        <ChevronRightIcon size={14} />
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
