import { useAui, useAuiState } from "@assistant-ui/react";
import { ActionIcon, Text, UnstyledButton } from "@mantine/core";
import { isPersistedThreadId } from "@shared/thread-identity";
import type { AttachmentRef } from "@shared/attachments";
import type { QueuedTurn } from "@shared/turn-queue";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import { appendUserTurn } from "@/runtime/attachment-message";
import { holdQueueLease, takeQueueLease } from "@/runtime/queue-lease";
import {
  suppressHistoryAppends,
  clearQueueEdit,
  getQueueEdit,
  keepQueueComposerRestore,
  type QueueEditLock,
} from "@/runtime/queue-edit";
import { publishCommandStatus } from "@/runtime/command-status";
import {
  canonicalMessageId,
  holdTurnObservation,
} from "@/runtime/message-identity";
import styles from "./QueueSidebar.module.css";

type QueueSnapshot = {
  threadId: string;
  items: QueuedTurn[];
  outgoingId: string | null;
  serviceHold: string | null;
};
const EMPTY_QUEUE: QueuedTurn[] = [];
const QueueContext = createContext<QueueSnapshot>({
  threadId: "",
  items: EMPTY_QUEUE,
  outgoingId: null,
  serviceHold: null,
});
function statusLabel(item: QueuedTurn): string {
  if (item.status === "editing") return "Editing";
  if (item.status === "pinned") return "Pinned";
  if (item.status === "failed") return "Paused";
  if (item.status === "interrupted") return "Interrupted";
  return "Queued";
}
/** Owns queue delivery independently of whether waiting rows are displayed. */
export function QueueLifecycleProvider({
  children,
}: PropsWithChildren): ReactElement {
  const aui = useAui();
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const isLoading = useAuiState((state) => state.thread.isLoading);
  const [snapshot, setSnapshot] = useState<QueueSnapshot>({
    threadId: "",
    items: EMPTY_QUEUE,
    outgoingId: null,
    serviceHold: null,
  });
  useEffect(() => {
    if (!isPersistedThreadId(threadId) || isLoading) return;
    let cancelled = false;
    void window.verbo.turns
      .snapshot(threadId)
      .then((live) => {
        const state = aui.thread().getState();
        if (
          cancelled ||
          !live?.userMessageId ||
          state.isRunning ||
          state.isLoading
        )
          return;
        const tail = state.messages.at(-1);
        if (
          tail?.role !== "user" ||
          canonicalMessageId(tail.id) !== live.userMessageId
        )
          return;
        holdTurnObservation(threadId, {
          userMessageId: live.userMessageId,
          assistantMessageId: live.assistantMessageId,
        });
        aui.thread().startRun({ parentId: tail.id });
      })
      .catch(() =>
        publishCommandStatus({
          status: "error",
          summary:
            "The active response could not be reattached. Reopen this chat to retry.",
        }),
      );
    return () => {
      cancelled = true;
    };
  }, [aui, threadId, isLoading]);
  useEffect(() => {
    if (!isPersistedThreadId(threadId)) return undefined;
    let cancelled = false;
    let requested = 0;
    const load = (): void => {
      const revision = ++requested;
      void window.verbo.queue
        .list(threadId)
        .then((next) => {
          if (!cancelled && requested === revision)
            setSnapshot({
              threadId,
              items: next.items,
              outgoingId: next.outgoingId,
              serviceHold: next.serviceHold,
            });
        })
        .catch(() => {
          if (!cancelled)
            publishCommandStatus({
              status: "error",
              summary: "Queued messages could not be loaded.",
            });
        });
    };
    load();
    const stop = window.verbo.queue.subscribe(load);
    return () => {
      cancelled = true;
      stop();
    };
  }, [threadId]);
  useEffect(() => {
    if (!isPersistedThreadId(threadId)) return undefined;
    let pending: {
      queueItemId: string;
      text: string;
      attachmentRefs: AttachmentRef[];
    } | null = null;
    const appendPending = (): void => {
      if (!pending || aui.thread().getState().isRunning) return;
      const next = pending;
      pending = null;
      suppressHistoryAppends(2);
      holdQueueLease(next.queueItemId);
      try {
        aui.thread().append(appendUserTurn(next.text, next.attachmentRefs));
      } catch {
        takeQueueLease();
        void window.verbo.queue.release(next.queueItemId);
        publishCommandStatus({
          status: "error",
          summary: "The promoted queued message could not be displayed.",
        });
      }
    };
    const stopStarted = window.verbo.turns.onStarted((payload) => {
      if (payload.event || payload.threadId !== threadId || !payload.text)
        return;
      pending = {
        queueItemId: payload.queueItemId,
        text: payload.text,
        attachmentRefs: payload.attachmentRefs ?? [],
      };
      appendPending();
    });
    const stopRun = aui.on("thread.runEnd", appendPending);
    return () => {
      stopStarted();
      stopRun();
    };
  }, [aui, threadId]);
  const visible =
    snapshot.threadId === threadId
      ? snapshot
      : { threadId, items: EMPTY_QUEUE, outgoingId: null, serviceHold: null };
  return (
    <QueueContext.Provider value={visible}>{children}</QueueContext.Provider>
  );
}

export function QueueRows(): ReactElement | null {
  const aui = useAui();
  const { threadId, items, outgoingId, serviceHold } = useContext(QueueContext);
  const waiting = items.filter((item) => item.id !== outgoingId);
  const report = (summary: string): void =>
    publishCommandStatus({ status: "error", summary });
  const edit = (item: QueuedTurn): void => {
    if (aui.composer().getState().attachments.length > 0) {
      report(
        "Send or remove composer attachments before editing a queued message.",
      );
      return;
    }
    void window.verbo.queue
      .beginEdit({
        id: item.id,
        threadId,
        revision: item.revision,
        composerText: aui.composer().getState().text,
        composerRefs: [],
      })
      .then((result) => {
        if (!result.ok || !result.item.editToken) {
          report(
            result.ok
              ? "That message can no longer be edited."
              : result.summary,
          );
          return;
        }
        if (aui.threads().getState().mainThreadId !== threadId) {
          void window.verbo.queue
            .cancelEdit({
              id: result.item.id,
              threadId,
              token: result.item.editToken,
            })
            .catch(() => report("The queued edit could not be cancelled."));
          return;
        }
        const lock: QueueEditLock = {
          id: result.item.id,
          revision: result.item.revision,
          token: result.item.editToken,
          threadId,
          attachmentRefs: result.item.attachmentRefs,
        };
        window.dispatchEvent(
          new CustomEvent("verbo:queue-edit", {
            detail: { threadId, text: result.item.text, lock },
          }),
        );
      })
      .catch(() => report("The queued message could not be edited."));
  };
  const remove = (item: QueuedTurn): void => {
    void window.verbo.queue
      .remove(item.id)
      .then((result) => {
        if (!result.ok) {
          report(result.summary);
          return;
        }
        if (item.status === "editing") {
          const lock = getQueueEdit(threadId);
          if (lock?.id === item.id) clearQueueEdit(lock);
          if (aui.threads().getState().mainThreadId !== threadId) {
            keepQueueComposerRestore(threadId, result.composerText ?? "");
            return;
          }
          window.dispatchEvent(
            new CustomEvent("verbo:queue-edit", {
              detail: { threadId, text: result.composerText ?? "", lock: null },
            }),
          );
          void aui.composer().clearAttachments();
        }
      })
      .catch(() => report("The queued message could not be removed."));
  };
  const reorder = (item: QueuedTurn, direction: "up" | "down"): void => {
    void window.verbo.queue
      .reorder({ id: item.id, threadId, revision: item.revision, direction })
      .then((result) => {
        if (!result.ok) report(result.summary);
      })
      .catch(() => report("The queued message could not be moved."));
  };
  if (!waiting.length && !serviceHold) return null;
  return (
    <section aria-label="Queued messages" className={styles.queue}>
      {serviceHold ? (
        <Text size="sm" role="status">
          {serviceHold}
        </Text>
      ) : null}
      {waiting.map((item, index) => (
        <article
          key={item.id}
          className={styles.row}
          aria-label={`${statusLabel(item)} message ${index + 1}`}
        >
          <Text size="xs" className={styles.status}>
            {statusLabel(item)}
          </Text>
          <UnstyledButton
            type="button"
            className={styles.preview}
            aria-label={`Edit queued message ${index + 1}: ${item.text}`}
            onClick={() => edit(item)}
          >
            {item.text}
          </UnstyledButton>
          {item.attachmentRefs.length ? (
            <Text
              size="xs"
              aria-label={`${item.attachmentRefs.length} attachments`}
            >
              +{item.attachmentRefs.length}
            </Text>
          ) : null}
          <div className={styles.actions}>
            <ActionIcon
              className={styles.action}
              size="sm"
              variant="transparent"
              aria-label={`Move queued message ${index + 1} up`}
              disabled={index === 0}
              onClick={() => reorder(item, "up")}
            >
              <ArrowUpIcon size={14} />
            </ActionIcon>
            <ActionIcon
              className={styles.action}
              size="sm"
              variant="transparent"
              aria-label={`Move queued message ${index + 1} down`}
              disabled={index === waiting.length - 1}
              onClick={() => reorder(item, "down")}
            >
              <ArrowDownIcon size={14} />
            </ActionIcon>
            <ActionIcon
              className={styles.action}
              size="sm"
              variant="transparent"
              aria-label={`Edit queued message ${index + 1}`}
              onClick={() => edit(item)}
            >
              <PencilIcon size={14} />
            </ActionIcon>
            <ActionIcon
              className={styles.action}
              size="sm"
              variant="transparent"
              aria-label={`Remove queued message ${index + 1}`}
              onClick={() => remove(item)}
            >
              <Trash2Icon size={14} />
            </ActionIcon>
          </div>
        </article>
      ))}
    </section>
  );
}
