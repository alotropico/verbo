import { Button, Group, Modal, Text } from "@mantine/core";
import { useAui, useAuiState } from "@assistant-ui/react";
import { Trash2Icon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  rangeChatSelection,
  toggleChatSelection,
  visibleChatSelection,
} from "./chat-selection";
import {
  ChatSelectionContext,
  useChatSelection,
  type ChatSelectionValue,
} from "./chat-selection-context";
import styles from "./ChatSelection.module.css";

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("input, textarea, [contenteditable='true']") !== null
  );
}

export function ChatSelectionProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const mainThreadId = useAuiState((state) => state.threads.mainThreadId);
  const threadIds = useAuiState((state) => state.threads.threadIds);
  const [trackedMain, setTrackedMain] = useState(mainThreadId);
  const [extraIds, setExtraIds] = useState<readonly string[]>([]);
  const visibleIdsRef = useRef<readonly string[]>([]);

  const mainChanged = trackedMain !== mainThreadId;
  if (mainChanged) {
    setTrackedMain(mainThreadId);
    setExtraIds([]);
  }
  const liveExtras = useMemo(
    () =>
      (mainChanged ? [] : extraIds).filter(
        (id) => id !== mainThreadId && threadIds.includes(id),
      ),
    [extraIds, mainChanged, mainThreadId, threadIds],
  );

  const cancel = useCallback(() => {
    setExtraIds((current) => (current.length === 0 ? current : []));
  }, []);

  const toggle = useCallback(
    (id: string) => {
      setExtraIds((current) => toggleChatSelection(mainThreadId, current, id));
    },
    [mainThreadId],
  );

  const selectRange = useCallback(
    (id: string) => {
      setExtraIds(rangeChatSelection(mainThreadId, visibleIdsRef.current, id));
    },
    [mainThreadId],
  );

  const selectVisible = useCallback(() => {
    setExtraIds(visibleChatSelection(mainThreadId, visibleIdsRef.current));
  }, [mainThreadId]);

  const setVisibleIds = useCallback((ids: readonly string[]) => {
    visibleIdsRef.current = ids;
  }, []);

  useEffect(() => {
    if (liveExtras.length === 0) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[role='menu'], [role='dialog']")
      ) {
        return;
      }
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, liveExtras.length]);

  const value = useMemo<ChatSelectionValue>(
    () => ({
      extraIds: liveExtras,
      isSelected: (id: string) =>
        id === mainThreadId || liveExtras.includes(id),
      toggle,
      selectRange,
      selectVisible,
      cancel,
      setVisibleIds,
    }),
    [
      cancel,
      liveExtras,
      mainThreadId,
      selectRange,
      selectVisible,
      setVisibleIds,
      toggle,
    ],
  );

  return (
    <ChatSelectionContext.Provider value={value}>
      {children}
    </ChatSelectionContext.Provider>
  );
}

function canDeleteStatus(status: string | undefined): boolean {
  return status === "regular" || status === "archived";
}

export function ChatSelectionBar(): ReactElement | null {
  const aui = useAui();
  const { cancel, extraIds } = useChatSelection();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (extraIds.length === 0 && !confirmOpen) return null;

  const count = extraIds.length > 0 ? extraIds.length + 1 : pendingCount;

  const closeConfirm = (): void => {
    if (busy) return;
    setConfirmOpen(false);
    setError("");
  };

  const removeSelected = (): void => {
    const snapshot = aui.threads.getState();
    const wanted = new Set([snapshot.mainThreadId, ...extraIds]);
    const ids = snapshot.threadItems
      .filter((item) => wanted.has(item.id) && canDeleteStatus(item.status))
      .map((item) => item.id);
    const ordered = [
      ...ids.filter((id) => id !== snapshot.mainThreadId),
      ...ids.filter((id) => id === snapshot.mainThreadId),
    ];
    if (ordered.length === 0) {
      setError("Those chats are not saved yet.");
      return;
    }

    setBusy(true);
    setError("");
    void (async () => {
      try {
        for (const id of ordered) {
          const current = aui.threads.getState();
          const item = current.threadItems.find((thread) => thread.id === id);
          if (!canDeleteStatus(item?.status)) continue;
          await aui.threads.item({ id }).delete();
        }
        setConfirmOpen(false);
        cancel();
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Could not delete chats.",
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Group
      className={styles.bar}
      gap="sm"
      role="toolbar"
      aria-label="Selected chats"
    >
      <Text className={styles.label} size="sm" fw={500} role="status">
        <span className={styles.count}>{count}</span> chats selected
      </Text>
      <Group gap="xs">
        <Button
          type="button"
          color="red"
          variant="light"
          size="sm"
          leftSection={<Trash2Icon size={14} aria-hidden="true" />}
          onClick={() => {
            setError("");
            setPendingCount(extraIds.length + 1);
            setConfirmOpen(true);
          }}
        >
          Delete selected
        </Button>
        <Button type="button" variant="subtle" size="sm" onClick={cancel}>
          Cancel
        </Button>
      </Group>
      <Modal
        opened={confirmOpen}
        onClose={closeConfirm}
        title={`Delete ${count} chats?`}
        centered
        closeOnClickOutside={!busy}
        closeOnEscape={!busy}
      >
        <Text size="sm" c="dimmed">
          This permanently deletes the selected chats and cannot be undone.
        </Text>
        {error ? (
          <Text className={styles.error} size="sm">
            {error}
          </Text>
        ) : null}
        <Group justify="flex-end" mt="md">
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={busy}
            onClick={closeConfirm}
          >
            Cancel
          </Button>
          <Button
            type="button"
            color="red"
            size="sm"
            loading={busy}
            onClick={removeSelected}
          >
            Delete chats
          </Button>
        </Group>
      </Modal>
    </Group>
  );
}
