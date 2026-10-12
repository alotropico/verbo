import { useAui, useAuiState } from "@assistant-ui/react";
import { Box, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { isPersistedThreadId } from "@shared/thread-identity";
import type { QueuedTurn } from "@shared/turn-queue";
import { PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { appendUserTurn } from "@/runtime/attachment-message";
import { holdQueueLease, takeQueueLease } from "@/runtime/queue-lease";
import styles from "./PendingQueue.module.css";

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 180 ? `${trimmed.slice(0, 180)}…` : trimmed;
}

function label(item: QueuedTurn): string {
  if (item.status === "pinned") return "Pinned to the previous branch";
  if (item.status === "failed") return "Paused after an error";
  if (item.status === "interrupted") return "Interrupted · not resent";
  if (item.status === "running") return "Sending";
  if (item.status === "awaiting_approval") return "Waiting for approval";
  return "Queued";
}

export function PendingQueue(): ReactElement | null {
  const aui = useAui();
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const [items, setItems] = useState<QueuedTurn[]>([]);
  const [hold, setHold] = useState(false);
  const [waitingForThreadId, setWaiting] = useState<string | null>(null);

  useEffect(() => {
    if (!isPersistedThreadId(threadId)) return undefined;
    let cancelled = false;
    const load = (): void => {
      void window.verbo.queue.list(threadId).then((snapshot) => {
        if (cancelled) return;
        setItems(snapshot.items);
        setHold(snapshot.hold);
        setWaiting(snapshot.waitingForThreadId);
      });
    };
    const kick = (): void => {
      if (cancelled || aui.thread().getState().isRunning) return;
      void window.verbo.queue.claim(threadId).then((result) => {
        if (!result.item) return;
        if (cancelled || aui.thread().getState().isRunning) {
          void window.verbo.queue.release(result.item.id);
          return;
        }
        holdQueueLease(result.item.id);
        try {
          aui
            .thread()
            .append(
              appendUserTurn(result.item.text, result.item.attachmentRefs),
            );
        } catch {
          takeQueueLease();
          void window.verbo.queue.release(result.item.id);
        }
      });
    };
    load();
    const stopQueue = window.verbo.queue.subscribe(() => {
      load();
      kick();
    });
    const stopRun = aui.on("thread.runEnd", kick);
    kick();
    return () => {
      cancelled = true;
      stopQueue();
      stopRun();
    };
  }, [aui, threadId]);

  if (!isPersistedThreadId(threadId)) return null;
  if (items.length === 0 && !hold && !waitingForThreadId) return null;

  return (
    <Paper
      component="section"
      className={styles.panel}
      p="md"
      radius="lg"
      aria-label="Pending messages"
    >
      <Stack gap="sm">
        {hold ? (
          <Group justify="space-between" gap="sm">
            <Group gap="sm" wrap="nowrap" className={styles.summary}>
              <PauseIcon
                className={styles.statusIcon}
                size={18}
                aria-hidden="true"
              />
              <Stack gap={2}>
                <Text size="sm" fw={500}>
                  Drafts paused
                </Text>
                <Text size="xs" c="dimmed">
                  Saved messages are ready to send.
                </Text>
              </Stack>
            </Group>
            <Button
              type="button"
              size="xs"
              variant="light"
              leftSection={<PlayIcon size={13} aria-hidden="true" />}
              onClick={() => void window.verbo.queue.releaseHold()}
            >
              Resume sending
            </Button>
          </Group>
        ) : null}
        {waitingForThreadId ? (
          <Text size="xs" c="dimmed">
            Waiting for an earlier message in another chat.
          </Text>
        ) : null}
        {items.length > 0 ? (
          <Box component="ul" className={styles.list}>
            {items.map((item) => (
              <li key={item.id} className={styles.item}>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed">
                    {label(item)}
                  </Text>
                  <Text className={styles.text} size="sm">
                    {preview(item.text)}
                  </Text>
                </Stack>
                <Group gap="xs">
                  {item.status === "queued" || item.status === "pinned" ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="subtle"
                      onClick={() => void window.verbo.queue.remove(item.id)}
                    >
                      Remove
                    </Button>
                  ) : null}
                  {item.status === "failed" ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="light"
                      onClick={() =>
                        void window.verbo.queue.acknowledge(item.id)
                      }
                    >
                      Continue queue
                    </Button>
                  ) : null}
                  {item.status === "interrupted" ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="light"
                      onClick={() => void window.verbo.queue.sendAgain(item.id)}
                    >
                      Send again
                    </Button>
                  ) : null}
                  {item.status === "pinned" ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="light"
                      onClick={() => void window.verbo.queue.rebind(item.id)}
                    >
                      Use this branch
                    </Button>
                  ) : null}
                  {item.status === "failed" ||
                  item.status === "interrupted" ||
                  item.status === "pinned" ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="subtle"
                      color="red"
                      onClick={() => void window.verbo.queue.discard(item.id)}
                    >
                      Discard
                    </Button>
                  ) : null}
                </Group>
              </li>
            ))}
          </Box>
        ) : null}
        {items.some(
          (item) => item.status === "queued" || item.status === "pinned",
        ) ? (
          <Group justify="flex-end">
            <Button
              type="button"
              size="xs"
              variant="subtle"
              color="red"
              onClick={() => void window.verbo.queue.clear(threadId)}
            >
              Clear pending
            </Button>
          </Group>
        ) : null}
      </Stack>
    </Paper>
  );
}
