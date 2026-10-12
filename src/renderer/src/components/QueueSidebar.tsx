import { useAui, useAuiState } from "@assistant-ui/react";
import { ActionIcon, Button, Group, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { isPersistedThreadId } from "@shared/thread-identity";
import type { AttachmentRef } from "@shared/attachments";
import type { QueuedTurn } from "@shared/turn-queue";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { appendUserTurn } from "@/runtime/attachment-message";
import { TtsControls } from "@/components/VoiceSession";
import { useVoiceSession } from "@/components/voice-session-context";
import { holdQueueLease } from "@/runtime/queue-lease";
import {
  suppressHistoryAppends,
  type QueueEditLock,
} from "@/runtime/queue-edit";
import { publishCommandStatus } from "@/runtime/command-status";
import styles from "./QueueSidebar.module.css";

function statusLabel(item: QueuedTurn): string {
  if (item.status === "editing") return "Editing";
  if (item.status === "pinned") return "Pinned";
  if (item.status === "failed") return "Paused";
  if (item.status === "interrupted") return "Interrupted";
  return "Queued";
}

export function QueueSidebar(): ReactElement | null {
  const aui = useAui();
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const narrow = useMediaQuery("(max-width: 47.99em)", false, {
    getInitialValueInEffect: false,
  });
  const [items, setItems] = useState<QueuedTurn[]>([]);
  const [outgoingId, setOutgoingId] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    if (!isPersistedThreadId(threadId)) return undefined;
    let cancelled = false;
    const load = (): void => {
      void window.verbo.queue.list(threadId).then((snapshot) => {
        if (cancelled) return;
        setItems(snapshot.items);
        setOutgoingId(snapshot.outgoingId);
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
      aui.thread().append(appendUserTurn(next.text, next.attachmentRefs));
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

  const queued = isPersistedThreadId(threadId);
  const voiceOn = useVoiceSession()?.active === true;
  const waiting = items.filter((item) => item.id !== outgoingId);

  const edit = (item: QueuedTurn): void => {
    const lock = window.dispatchEvent;
    void window.verbo.queue
      .beginEdit({
        id: item.id,
        threadId,
        revision: item.revision,
        composerText: "",
        composerRefs: [],
      })
      .then((result) => {
        if (!result.ok || !result.item.editToken) {
          publishCommandStatus({
            status: "error",
            summary: result.ok
              ? "That message can no longer be edited."
              : result.summary,
          });
          return;
        }
        const next: QueueEditLock = {
          id: result.item.id,
          revision: result.item.revision,
          token: result.item.editToken,
          threadId,
          attachmentRefs: result.item.attachmentRefs,
        };
        lock(
          new CustomEvent("verbo:queue-edit", {
            detail: { text: result.item.text, lock: next },
          }),
        );
      });
  };

  const remove = (item: QueuedTurn): void => {
    void window.verbo.queue.remove(item.id).then((result) => {
      if (!result.ok) {
        publishCommandStatus({ status: "error", summary: result.summary });
        return;
      }
      if (item.status === "editing") {
        window.dispatchEvent(
          new CustomEvent("verbo:queue-edit", {
            detail: { text: result.composerText ?? "", lock: null },
          }),
        );
      }
    });
  };

  const body = (
    <aside
      className={
        narrow && drawer ? `${styles.sidebar} ${styles.drawer}` : styles.sidebar
      }
      aria-label="Queue and speech"
    >
      <div className={styles.queueBody}>
      {!open ? (
        <div className={styles.rail} aria-label="Queued messages">
          {waiting.map((item) => (
            <button
              key={item.id}
              type="button"
              className={
                item.status === "editing"
                  ? `${styles.marker} ${styles.markerEditing}`
                  : styles.marker
              }
              aria-label={`${statusLabel(item)}. ${item.text}`}
              onClick={() => setOpen(true)}
            />
          ))}
        </div>
      ) : queued && waiting.length > 0 ? (
        <>
      <Group justify="space-between">
        <Text size="xs">Queue</Text>
        <ActionIcon
          variant="subtle"
          size="sm"
          aria-label={narrow ? "Close queue" : "Minimize queue"}
          onClick={() => {
            if (narrow) setDrawer(false);
            else setOpen(false);
          }}
        >
          <XIcon size={14} />
        </ActionIcon>
      </Group>
      {waiting.map((item, index) => (
        <article
          key={item.id}
          className={styles.row}
          tabIndex={0}
          aria-label={`${statusLabel(item)}. ${item.text}`}
          onKeyDown={(event) => {
            if (event.key === "Delete" || event.key === "Backspace") {
              event.preventDefault();
              remove(item);
            } else if (event.key === "Enter") {
              event.preventDefault();
              edit(item);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              void window.verbo.queue.reorder({
                id: item.id,
                threadId,
                revision: item.revision,
                direction: "up",
              });
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              void window.verbo.queue.reorder({
                id: item.id,
                threadId,
                revision: item.revision,
                direction: "down",
              });
            }
          }}
        >
          <button
            type="button"
            className={styles.preview}
            aria-expanded={expandedId === item.id}
            onClick={() =>
              setExpandedId((current) => (current === item.id ? null : item.id))
            }
          >
            {expandedId === item.id ? item.text : item.text}
          </button>
          <Text size="xs">{statusLabel(item)}</Text>
          <div className={styles.actions}>
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label={`Edit queued message ${index + 1}`}
              onClick={() => edit(item)}
            >
              <PencilIcon size={14} />
            </ActionIcon>
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label={`Remove queued message ${index + 1}`}
              onClick={() => remove(item)}
            >
              <Trash2Icon size={14} />
            </ActionIcon>
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label={`Move queued message ${index + 1} up`}
              onClick={() =>
                void window.verbo.queue.reorder({
                  id: item.id,
                  threadId,
                  revision: item.revision,
                  direction: "up",
                })
              }
            >
              <ArrowUpIcon size={14} />
            </ActionIcon>
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label={`Move queued message ${index + 1} down`}
              onClick={() =>
                void window.verbo.queue.reorder({
                  id: item.id,
                  threadId,
                  revision: item.revision,
                  direction: "down",
                })
              }
            >
              <ArrowDownIcon size={14} />
            </ActionIcon>
          </div>
        </article>
      ))}
        </>
      ) : null}
      </div>
      <TtsControls />
    </aside>
  );

  if (!voiceOn && (!queued || waiting.length === 0)) return null;

  if (narrow && !drawer) {
    return (
      <Button
        type="button"
        size="compact-xs"
        variant="subtle"
        aria-label="Open queue"
        onClick={() => setDrawer(true)}
      >
        {items.length}
      </Button>
    );
  }

  return body;
}
