"use client";

import {
  ActionIcon,
  Button,
  Input,
  Skeleton,
  type ButtonProps,
} from "@mantine/core";
import { publishCommandStatus } from "@/runtime/command-status";
import {
  subscribeThreadActivity,
  threadActivity,
  timestampMs,
} from "@/runtime/thread-activity";
import { SettingsPanel } from "@/components/SettingsPanel";
import { useChatSelection } from "@/components/chat-selection-context";
import { cx } from "@/lib/cx";
import a11y from "@/lib/a11y.module.css";
import {
  chatExportFilename,
  chatExportJson,
  chatExportMarkdown,
  readExportMessages,
  type ChatExport,
} from "@shared/chat-export";
import { chatPlaceholderTitle } from "@shared/thread-title";
import { savedRemoteThreadId } from "@shared/thread-identity";
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArchiveIcon,
  FileJsonIcon,
  FileTextIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  XIcon,
} from "lucide-react";
import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import styles from "./thread-list.module.css";

export const ThreadList: FC = () => {
  const [search, setSearch] = useState("");
  const hasThreads = useAuiState((s) => s.threads.threadIds.length > 0);
  const { selectVisible } = useChatSelection();

  return (
    <ThreadListRoot
      onKeyDown={(event) => {
        if (event.key !== "a" || event.shiftKey || event.altKey) return;
        if (!(event.ctrlKey || event.metaKey)) return;
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          target.closest("input, textarea, [contenteditable='true']")
        ) {
          return;
        }
        event.preventDefault();
        selectVisible();
      }}
    >
      {hasThreads && (
        <ThreadListSearch value={search} onValueChange={setSearch} />
      )}
      <ThreadListItems searchQuery={hasThreads ? search : ""} />
      <div className={styles.sidebarActions}>
        <ThreadListNew />
        <SettingsPanel />
      </div>
    </ThreadListRoot>
  );
};

export const ThreadListSearch = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<"input">, "value" | "onChange" | "size"> & {
    value: string;
    onValueChange: (value: string) => void;
  }
>(({ className, value, onValueChange, ...props }, ref) => {
  return (
    <div data-slot="aui_thread-list-search" className={styles.searchWrap}>
      <Input
        ref={ref}
        type="search"
        radius="xl"
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        aria-label="Search threads"
        placeholder="Search threads"
        leftSection={
          <SearchIcon
            data-slot="aui_thread-list-search-icon"
            className={styles.searchIcon}
          />
        }
        leftSectionPointerEvents="none"
        rightSection={
          value.length > 0 ? (
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label="Clear search"
              className={styles.searchClear}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onValueChange("")}
            >
              <XIcon className={styles.searchIcon} />
            </ActionIcon>
          ) : null
        }
        rightSectionPointerEvents="auto"
        classNames={{ input: cx(styles.searchInput, className) }}
        {...props}
      />
    </div>
  );
});

ThreadListSearch.displayName = "ThreadListSearch";

export const ThreadListRoot: FC<
  ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>
> = ({ className, ...props }) => {
  return (
    <ThreadListPrimitive.Root
      data-slot="aui_thread-list-root"
      className={cx(styles.root, className)}
      {...props}
    />
  );
};

export const ThreadListItems: FC<
  ComponentPropsWithoutRef<"div"> & { searchQuery?: string }
> = ({ className, searchQuery = "", ...props }) => {
  return (
    <div
      data-slot="aui_thread-list-items"
      className={cx(styles.items, className)}
      {...props}
    >
      <AuiIf condition={(s) => s.threads.isLoading}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !s.threads.isLoading}>
        <ThreadListItemGroups searchQuery={searchQuery} />
      </AuiIf>
    </div>
  );
};

const useFilteredThreadIndices = (searchQuery = "") => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const query = searchQuery.trim().toLowerCase();

  return useMemo(() => {
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const filteredIndices = threadIds
      .map((id, index) => ({ id, index }))
      .filter(
        ({ id }) =>
          !query ||
          (itemsById.get(id)?.title || chatPlaceholderTitle(id))
            .toLowerCase()
            .includes(query),
      )
      .map(({ index }) => index);
    return { threadIds, filteredIndices };
  }, [threadIds, threadItems, query]);
};

const ThreadListItemGroups: FC<{ searchQuery?: string }> = ({
  searchQuery = "",
}) => {
  const { threadIds, filteredIndices } = useFilteredThreadIndices(searchQuery);
  const { setVisibleIds } = useChatSelection();
  const query = searchQuery.trim();
  const visibleIds = useMemo(
    () =>
      filteredIndices.flatMap((index) => {
        const id = threadIds[index];
        return id ? [id] : [];
      }),
    [filteredIndices, threadIds],
  );
  setVisibleIds(visibleIds);

  if (query && filteredIndices.length === 0) {
    return (
      <div data-slot="aui_thread-list-empty" className={styles.empty}>
        No threads found
      </div>
    );
  }

  return filteredIndices.map((index) => (
    <ThreadListPrimitive.ItemByIndex
      key={threadIds[index]}
      index={index}
      components={{ ThreadListItem }}
    />
  ));
};

export const ThreadListNew = forwardRef<
  HTMLButtonElement,
  ButtonProps & { labelClassName?: string }
>(({ className, labelClassName, children, ...props }, ref) => {
  return (
    <div className={styles.newWrap}>
      <ThreadListPrimitive.New
        render={
          <Button
            ref={ref}
            variant="default"
            radius="xl"
            fullWidth
            justify="flex-start"
            data-slot="aui_thread-list-new"
            className={cx(styles.newButton, className)}
            {...props}
          />
        }
      >
        {children ?? (
          <>
            <PlusIcon
              data-slot="aui_thread-list-new-icon"
              className={styles.newIcon}
            />
            <span
              data-slot="aui_thread-list-new-label"
              className={cx(styles.newLabel, labelClassName)}
            >
              New chat
            </span>
          </>
        )}
      </ThreadListPrimitive.New>
    </div>
  );
});

ThreadListNew.displayName = "ThreadListNew";

const ThreadListSkeleton: FC = () => {
  return (
    <div
      role="status"
      aria-label="Loading threads"
      className={styles.skeletonRoot}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          data-slot="aui_thread-list-skeleton-wrapper"
          className={styles.skeletonRow}
        >
          <Skeleton
            data-slot="aui_thread-list-skeleton"
            className={styles.skeletonBar}
          />
        </div>
      ))}
    </div>
  );
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let clockNow = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: number | undefined;

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === undefined) {
    clockTimer = window.setInterval(() => {
      clockNow = Date.now();
      clockListeners.forEach((entry) => entry());
    }, 15_000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== undefined) {
      window.clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}

function readClock(): number {
  return clockNow;
}

function formatTimeAgo(at: number, now: number, long = false): string {
  const delta = Math.max(0, now - at);
  if (delta < 45_000) return "just now";
  if (delta < HOUR) {
    const minutes = Math.max(1, Math.round(delta / MINUTE));
    return long
      ? `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`
      : `${minutes}m ago`;
  }
  if (delta < DAY) {
    const hours = Math.round(delta / HOUR);
    return long
      ? `${hours} ${hours === 1 ? "hour" : "hours"} ago`
      : `${hours}h ago`;
  }
  if (delta < 14 * DAY) {
    const days = Math.round(delta / DAY);
    return long ? `${days} ${days === 1 ? "day" : "days"} ago` : `${days}d ago`;
  }
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(at);
}

function readMessageCount(custom: Record<string, unknown> | undefined): number {
  const value = custom?.messageCount;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const threadTriggers = (node: HTMLElement): HTMLButtonElement[] => {
  const root = node.closest("[data-slot='aui_thread-list-root']");
  if (!root) return [];
  return [
    ...root.querySelectorAll<HTMLButtonElement>(
      "[data-slot='aui_thread-list-item-trigger']",
    ),
  ];
};

export const ThreadListItem: FC = () => {
  const isRunning = useAuiState((s) => s.threadListItem.isRunning);
  const itemId = useAuiState((s) => s.threadListItem.id);
  const storedAt = useAuiState((s) => {
    const item = s.threads.threadItems.find(
      (entry) => entry.id === s.threadListItem.id,
    );
    return timestampMs(item?.lastMessageAt);
  });
  const storedCount = useAuiState((s) => {
    const item = s.threads.threadItems.find(
      (entry) => entry.id === s.threadListItem.id,
    );
    return readMessageCount(item?.custom);
  });
  const live = useSyncExternalStore(
    subscribeThreadActivity,
    () => threadActivity(itemId),
    () => threadActivity(itemId),
  );
  const now = useSyncExternalStore(subscribeClock, readClock, readClock);
  const at = Math.max(storedAt, live?.at ?? 0);
  const count = Math.max(storedCount, live?.count ?? 0);
  const messageLabel = `${count} ${count === 1 ? "message" : "messages"}`;
  const { cancel, extraIds, isSelected, selectRange, toggle } =
    useChatSelection();
  const [isRenaming, setIsRenaming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const selected = extraIds.length > 0 && isSelected(itemId);

  useEffect(() => {
    if (isRenaming || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [isRenaming]);

  const onItemKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const trigger = target.closest<HTMLButtonElement>(
      "[data-slot='aui_thread-list-item-trigger']",
    );
    if (!trigger) return;

    const command = event.ctrlKey || event.metaKey;
    if (
      (event.key === "Enter" || event.key === " ") &&
      command &&
      !event.shiftKey
    ) {
      event.preventDefault();
      toggle(itemId);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && event.shiftKey) {
      event.preventDefault();
      selectRange(itemId);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (event.altKey || (command && event.shiftKey)) return;
    if (!command && !event.shiftKey) return;

    const triggers = threadTriggers(trigger);
    const next =
      triggers[
        triggers.indexOf(trigger) + (event.key === "ArrowDown" ? 1 : -1)
      ];
    if (!next) return;
    event.preventDefault();
    next.focus();
    if (!event.shiftKey) return;
    const nextId = next
      .closest("[data-thread-id]")
      ?.getAttribute("data-thread-id");
    if (nextId) selectRange(nextId);
  };

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      data-thread-id={itemId}
      data-selected={selected ? "true" : undefined}
      className={styles.itemRoot}
      onKeyDown={onItemKeyDown}
    >
      {isRenaming ? (
        <ThreadListItemRename
          onDone={(restoreFocus) => {
            restoreFocusRef.current = restoreFocus;
            setIsRenaming(false);
          }}
        />
      ) : (
        <ThreadListItemPrimitive.Trigger
          ref={triggerRef}
          data-slot="aui_thread-list-item-trigger"
          className={styles.trigger}
          onClick={(event) => {
            if (event.shiftKey) {
              event.preventDefault();
              selectRange(itemId);
              return;
            }
            if (event.ctrlKey || event.metaKey) {
              event.preventDefault();
              toggle(itemId);
              return;
            }
            cancel();
          }}
        >
          {isRunning && (
            <Loader2Icon
              aria-hidden
              data-slot="aui_thread-list-item-running"
              className={styles.runningIcon}
            />
          )}
          <span className={styles.itemBody}>
            <span
              data-slot="aui_thread-list-item-title"
              className={styles.itemTitle}
            >
              <ThreadListItemPrimitive.Title
                fallback={chatPlaceholderTitle(itemId)}
              />
            </span>
            {count > 0 ? (
              <span
                className={styles.itemMeta}
                aria-label={
                  at > 0
                    ? `Last message ${formatTimeAgo(at, now, true)}, ${messageLabel}`
                    : messageLabel
                }
              >
                {at > 0
                  ? `${formatTimeAgo(at, now)} • ${messageLabel}`
                  : messageLabel}
              </span>
            ) : null}
          </span>
          {selected ? <span className={a11y.srOnly}>Selected</span> : null}
          {isRunning && <span className={a11y.srOnly}>Running</span>}
        </ThreadListItemPrimitive.Trigger>
      )}
      <ThreadListItemMore onRename={() => setIsRenaming(true)} />
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItemRename: FC<{
  onDone: (restoreFocus: boolean) => void;
}> = ({ onDone }) => {
  const aui = useAui();
  const title = useAuiState((s) => s.threadListItem.title) ?? "";
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = (restoreFocus: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;

    const next = value.trim();
    if (!next || next === title) {
      onDone(restoreFocus);
      return;
    }

    // Deferred so a synchronous throw lands on the rejection path too.
    Promise.resolve()
      .then(() => aui.threadListItem.rename(next))
      .then(
        () => onDone(restoreFocus),
        () => {
          settledRef.current = false;
          if (restoreFocus) inputRef.current?.focus();
        },
      );
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onDone(true);
  };

  return (
    <Input
      ref={inputRef}
      autoFocus
      variant="unstyled"
      data-slot="aui_thread-list-item-rename"
      aria-label="Rename thread"
      value={value}
      classNames={{ wrapper: styles.renameWrap, input: styles.renameInput }}
      onChange={(event) => setValue(event.currentTarget.value)}
      onBlur={() => commit(false)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
          return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
};

const downloadText = (filename: string, mime: string, text: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

const exportChatFile = async (
  kind: "json" | "md",
  item: {
    id: string;
    remoteId: string | undefined;
    status: string;
    title?: string | undefined;
  },
): Promise<void> => {
  const title = item.title?.trim() || chatPlaceholderTitle(item.id);
  const savedId = savedRemoteThreadId({
    status: item.status,
    remoteId: item.remoteId,
  });
  const loaded = savedId
    ? await window.verbo.storage.loadMessages(savedId)
    : { messages: [], headId: null };
  const chat: ChatExport = {
    id: savedId ?? item.id,
    title,
    headId: loaded.headId,
    messages: readExportMessages(loaded.messages),
  };
  const text =
    kind === "json" ? chatExportJson(chat) : chatExportMarkdown(chat);
  const mime =
    kind === "json" ? "application/json" : "text/markdown;charset=utf-8";
  downloadText(chatExportFilename(title, kind), mime, text);
};

const ThreadListItemMore: FC<{ onRename: () => void }> = ({ onRename }) => {
  const aui = useAui();

  const exportAs = (kind: "json" | "md"): void => {
    const item = aui.threadListItem.getState();
    void exportChatFile(kind, item).catch((error: unknown) => {
      publishCommandStatus({
        status: "error",
        summary:
          error instanceof Error
            ? error.message
            : "Could not export that chat.",
      });
    });
  };

  return (
    <ThreadListItemMorePrimitive.Root sharedFocusGroup>
      <ThreadListItemMorePrimitive.Trigger
        render={
          <ActionIcon
            variant="subtle"
            data-slot="aui_thread-list-item-more"
            className={styles.moreTrigger}
            aria-label="More options"
          />
        }
      >
        <MoreHorizontalIcon className={styles.moreIcon} />
        <span className={a11y.srOnly}>More options</span>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="right"
        align="start"
        sideOffset={6}
        data-slot="aui_thread-list-item-more-content"
        className={styles.moreContent}
      >
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className={styles.moreItem}
          onSelect={onRename}
        >
          <PencilIcon className={styles.moreItemIcon} />
          Rename
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className={styles.moreItem}
          onSelect={() => exportAs("json")}
        >
          <FileJsonIcon className={styles.moreItemIcon} />
          Export as JSON
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className={styles.moreItem}
          onSelect={() => exportAs("md")}
        >
          <FileTextIcon className={styles.moreItemIcon} />
          Export as MD
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemPrimitive.Archive
          render={
            <ThreadListItemMorePrimitive.Item
              data-slot="aui_thread-list-item-more-item"
              className={styles.moreItem}
            />
          }
        >
          <ArchiveIcon className={styles.moreItemIcon} />
          Archive
        </ThreadListItemPrimitive.Archive>
        <ThreadListItemPrimitive.Delete
          render={
            <ThreadListItemMorePrimitive.Item
              data-slot="aui_thread-list-item-more-item"
              className={cx(styles.moreItem, styles.moreItemDestructive)}
            />
          }
        >
          <TrashIcon className={styles.moreItemIcon} />
          Delete
        </ThreadListItemPrimitive.Delete>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};
