import {
  unstable_useComposerInput,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import type { AttachmentRef } from "@shared/attachments";
import { parseLocalCommand } from "@shared/local-commands";
import {
  isPersistedThreadId,
  savedRemoteThreadId,
} from "@shared/thread-identity";
import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import {
  appendUserTurn,
  storeAttachmentFile,
} from "@/runtime/attachment-message";
import { publishCommandStatus } from "@/runtime/command-status";
import {
  getQueueEdit,
  setQueueEdit,
  type QueueEditLock,
} from "@/runtime/queue-edit";
import { holdQueueLease, takeQueueLease } from "@/runtime/queue-lease";

export function useLocalCommandGuard(): {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  sendOrCommand: () => void;
  canSend: boolean;
} {
  const aui = useAui();
  const input = unstable_useComposerInput();
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const attachmentCount = useAuiState(
    (state) => state.composer.attachments.length,
  );
  const sending = useRef(false);
  useEffect(() => {
    const onEdit = (event: Event): void => {
      const detail = (
        event as CustomEvent<{ text: string; lock: QueueEditLock | null }>
      ).detail;
      setQueueEdit(detail.lock);
      input.setText(detail.text);
    };
    window.addEventListener("verbo:queue-edit", onEdit);
    return () => window.removeEventListener("verbo:queue-edit", onEdit);
  }, [input]);

  const runIfCommand = (): boolean => {
    if (!parseLocalCommand(input.value).handled) return false;
    const text = input.value;
    input.setText("");
    void window.verbo.commands
      .run({
        text,
        ...(isPersistedThreadId(threadId) ? { threadId } : {}),
      })
      .then((result) => {
        publishCommandStatus(result);
        if (result.newThread) aui.threads().switchToNewThread();
        if (result.openMemory) {
          window.dispatchEvent(
            new CustomEvent("verbo:open-settings", {
              detail: { tab: "memory" },
            }),
          );
        }
        window.dispatchEvent(new Event("verbo:memory-changed"));
      })
      .catch((error: unknown) => {
        input.setText(text);
        publishCommandStatus({
          status: "error",
          summary: error instanceof Error ? error.message : "Command failed.",
        });
      });
    return true;
  };

  const submitText = (): void => {
    const text = input.value.trim();
    const pending = aui.composer().getState().attachments;
    if ((!text && pending.length === 0) || sending.current || runIfCommand())
      return;
    sending.current = true;
    void (async () => {
      const stored: AttachmentRef[] = [];
      try {
        const threads = aui.threads().getState();
        const item = threads.threadItems.find(
          (thread) => thread.id === threads.mainThreadId,
        );
        const remoteId =
          savedRemoteThreadId(item) ??
          (await aui.threadListItem().initialize()).remoteId;
        for (const attachment of pending) {
          if (!attachment.file) continue;
          const savedFile = await storeAttachmentFile({
            threadId: remoteId,
            file: attachment.file,
          });
          if (!savedFile.ok) {
            publishCommandStatus({
              status: "error",
              summary: savedFile.summary,
            });
            for (const ref of stored) {
              await window.verbo.attachments.remove({
                threadId: remoteId,
                id: ref.id,
              });
            }
            return;
          }
          stored.push(savedFile.attachment);
        }
        const editing = getQueueEdit();
        if (editing) {
          const saved = await window.verbo.queue.saveEdit({
            id: editing.id,
            threadId: editing.threadId,
            revision: editing.revision,
            token: editing.token,
            text: text || stored.map((ref) => ref.name).join(", "),
            attachmentRefs: stored.length > 0 ? stored : editing.attachmentRefs,
          });
          if (!saved.ok) {
            publishCommandStatus({ status: "error", summary: saved.summary });
            return;
          }
          setQueueEdit(null);
          input.setText(saved.composerText);
          await aui.composer().clearAttachments();
          return;
        }
        const queuedText = text || stored.map((ref) => ref.name).join(", ");
        const anchor = aui.thread().getState().messages.at(-1)?.id ?? null;
        const saved = await window.verbo.queue.enqueue({
          threadId: remoteId,
          text: queuedText,
          branchAnchor: anchor,
          source: "typed",
          attachmentRefs: stored,
        });
        if (!saved.ok) {
          publishCommandStatus({ status: "error", summary: saved.summary });
          for (const ref of stored) {
            await window.verbo.attachments.remove({
              threadId: remoteId,
              id: ref.id,
            });
          }
          return;
        }
        input.setText("");
        await aui.composer().clearAttachments();
        if (!saved.start) return;
        holdQueueLease(saved.item.id);
        try {
          aui.thread().append(appendUserTurn(queuedText, stored));
        } catch (error: unknown) {
          takeQueueLease();
          await window.verbo.queue.release(saved.item.id);
          throw error;
        }
      } catch (error: unknown) {
        publishCommandStatus({
          status: "error",
          summary:
            error instanceof Error
              ? error.message
              : "Could not queue that message.",
        });
      } finally {
        sending.current = false;
      }
    })();
  };

  return {
    onSubmit: (event) => {
      event.preventDefault();
      submitText();
    },
    onKeyDown: (event) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      if (event.nativeEvent.isComposing) return;
      if (!isRunning && !getQueueEdit()) return;
      event.preventDefault();
      submitText();
    },
    sendOrCommand: () => {
      submitText();
    },
    canSend:
      (input.value.trim().length > 0 || attachmentCount > 0) &&
      !input.isDisabled,
  };
}
