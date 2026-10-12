"use client";

import {
  ActionIcon,
  Button,
  Input,
  Skeleton,
  type ButtonProps,
} from "@mantine/core";
import { publishCommandStatus } from "@/runtime/command-status";
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
  Fragment,
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
      <ThreadListNew />
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

const dateGroupLabel = (
  date: Date | undefined,
  startOfToday: number,
  startOfYesterday: number,
): string => {
  if (!date || date.getTime() >= startOfToday) return "Today";
  if (date.getTime() >= startOfYesterday) return "Yesterday";
  return "Earlier";
};

const startOfLocalDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

const subscribeToNextDay = (onDayChange: () => void) => {
  let timeout: number;
  const scheduleNextDay = () => {
    const now = new Date();
    const startOfTomorrow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    ).getTime();
    timeout = window.setTimeout(() => {
      onDayChange();
      scheduleNextDay();
    }, startOfTomorrow - now.getTime());
  };
  scheduleNextDay();
  return () => window.clearTimeout(timeout);
};

const getStartOfToday = () => startOfLocalDay(new Date());

// A server render and hydration see no day start, so a prerender never reads
// the clock; a client-only mount groups on its first render.
const getServerStartOfToday = () => undefined;

const useStartOfToday = () =>
  useSyncExternalStore<number | undefined>(
    subscribeToNextDay,
    getStartOfToday,
    getServerStartOfToday,
  );

export type ThreadListGroup = { label: string; indices: number[] };

/**
 * Filters the thread list by title and buckets the matches by last activity
 * (Today, Yesterday, Earlier). `groups` is null when no thread carries a date
 * or while the local day start is unknown during server render and hydration,
 * in which case `filteredIndices` keeps the runtime order.
 */
export const useThreadListGroups = (searchQuery = "") => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);

  const query = searchQuery.trim().toLowerCase();
  const startOfToday = useStartOfToday();

  return useMemo(() => {
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const dates = threadIds.map((id) => itemsById.get(id)?.lastMessageAt);
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
    if (
      startOfToday === undefined ||
      !filteredIndices.some((index) => dates[index])
    ) {
      return { threadIds, filteredIndices, groups: null };
    }

    const yesterday = new Date(startOfToday);
    yesterday.setDate(yesterday.getDate() - 1);
    const startOfYesterday = yesterday.getTime();
    const time = (index: number) =>
      dates[index]?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const sorted = [...filteredIndices].sort((a, b) => time(b) - time(a));

    const result: ThreadListGroup[] = [];
    for (const index of sorted) {
      const label = dateGroupLabel(
        dates[index],
        startOfToday,
        startOfYesterday,
      );
      const lastGroup = result[result.length - 1];
      if (lastGroup?.label === label) {
        lastGroup.indices.push(index);
      } else {
        result.push({ label, indices: [index] });
      }
    }
    return { threadIds, filteredIndices, groups: result };
  }, [threadIds, threadItems, query, startOfToday]);
};

const ThreadListItemGroups: FC<{ searchQuery?: string }> = ({
  searchQuery = "",
}) => {
  const { threadIds, filteredIndices, groups } =
    useThreadListGroups(searchQuery);
  const { setVisibleIds } = useChatSelection();
  const query = searchQuery.trim();
  const visibleIds = useMemo(() => {
    const indices = groups
      ? groups.flatMap((group) => group.indices)
      : filteredIndices;
    return indices.flatMap((index) => {
      const id = threadIds[index];
      return id ? [id] : [];
    });
  }, [filteredIndices, groups, threadIds]);
  setVisibleIds(visibleIds);

  if (query && filteredIndices.length === 0) {
    return (
      <div data-slot="aui_thread-list-empty" className={styles.empty}>
        No threads found
      </div>
    );
  }

  if (!groups) {
    return filteredIndices.map((index) => (
      <ThreadListPrimitive.ItemByIndex
        key={threadIds[index]}
        index={index}
        components={{ ThreadListItem }}
      />
    ));
  }

  return groups.map((group) => (
    <Fragment key={group.label}>
      <div
        data-slot="aui_thread-list-group-label"
        className={styles.groupLabel}
      >
        {group.label}
      </div>
      {group.indices.map((index) => (
        <ThreadListPrimitive.ItemByIndex
          key={threadIds[index]}
          index={index}
          components={{ ThreadListItem }}
        />
      ))}
    </Fragment>
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
          <span
            data-slot="aui_thread-list-item-title"
            className={styles.itemTitle}
          >
            <ThreadListItemPrimitive.Title
              fallback={chatPlaceholderTitle(itemId)}
            />
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
