import { useEffect, useState, type ReactElement } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Modal,
  Pagination,
  ScrollArea,
  Text,
} from "@mantine/core";
import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import {
  ChevronRightIcon,
  CopyIcon,
  FileIcon,
  FolderOpenIcon,
} from "lucide-react";
import type { FileSurfaceIntent } from "@shared/file-surface";
import type { CommandReceipt, CommandResource } from "@shared/command-receipts";
import {
  commandReceiptIdsFromParts,
  touchedFileName,
  touchedFilesFromParts,
  touchedFilesFromItems,
  type TouchedFileReview,
} from "@shared/touched-files";
import { StatusMessage } from "@/components/StatusMessage";
import { notify } from "@/lib/notify";
import {
  CollapsibleRoot,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./collapsible-root";
import styles from "./touched-files.module.css";
import {
  MessageFileAttachment,
  MessageImageAttachment,
} from "./attachment.aui";

function ResourceRow({
  resource,
  onIntent,
}: {
  resource: CommandResource;
  onIntent: (intent: FileSurfaceIntent, path: string) => void;
}): ReactElement {
  const name = touchedFileName(resource.path);
  return (
    <CollapsibleRoot className={styles.resource}>
      <Group gap="xs" wrap="nowrap">
        <CollapsibleTrigger
          className={styles.trigger}
          aria-label={`Details for ${name}`}
        >
          <ChevronRightIcon className={styles.chevron} size={14} aria-hidden />
          <FileIcon size={14} aria-hidden />
          <span className={styles.name}>{name}</span>
        </CollapsibleTrigger>
        <Group className={styles.actions} gap={2} wrap="nowrap">
          <ActionIcon
            className={styles.action}
            variant="transparent"
            size="sm"
            aria-label={`Open ${name}`}
            disabled={!resource.available}
            onClick={() => onIntent("open", resource.path)}
          >
            <FileIcon size={14} />
          </ActionIcon>
          <ActionIcon
            className={styles.action}
            variant="transparent"
            size="sm"
            aria-label={`Show ${name} in folder`}
            disabled={!resource.available}
            onClick={() => onIntent("reveal", resource.path)}
          >
            <FolderOpenIcon size={14} />
          </ActionIcon>
          <ActionIcon
            className={styles.action}
            variant="transparent"
            size="sm"
            aria-label={`Copy content of ${name}`}
            disabled={!resource.available}
            onClick={() => onIntent("copy", resource.path)}
          >
            <CopyIcon size={14} />
          </ActionIcon>
        </Group>
      </Group>
      <CollapsibleContent className={styles.details}>
        <Text size="xs">{resource.path}</Text>
        <Text size="xs">
          {resource.event}
          {resource.from ? ` · from ${resource.from}` : ""}
        </Text>
        {resource.unavailableReason ? (
          <Text size="xs">{resource.unavailableReason}</Text>
        ) : null}
      </CollapsibleContent>
    </CollapsibleRoot>
  );
}

export function TouchedFiles(): ReactElement | null {
  const parts = useAuiState((state) => state.message.parts);
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const receiptKey = commandReceiptIdsFromParts(parts).join("|");
  const scan = touchedFilesFromParts(parts);
  const reviewKey = JSON.stringify(scan.reviews);
  const key = `${threadId}:${receiptKey}:${reviewKey}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    receipts: CommandReceipt[];
    legacy: CommandResource[];
    error?: string;
  } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [page, setPage] = useState(1);
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const receipts: CommandReceipt[] = [];
        if (threadId && receiptKey) {
          for (const receiptId of receiptKey.split("|")) {
            let offset = 0;
            let receipt: CommandReceipt | null = null;
            for (;;) {
              const page = await window.verbo.commands.receipt({
                receiptId,
                threadId,
                offset,
              });
              if (cancelled) return;
              if (!page) break;
              if (receipt) receipt.resources.push(...page.resources);
              else receipt = page;
              if (!page.more) break;
              offset += page.resources.length;
              if (offset > 10000 || page.resources.length === 0)
                throw new Error("Invalid receipt page");
            }
            if (receipt) receipts.push(receipt);
          }
        }
        const legacy: CommandResource[] = [];
        if (!receiptKey) {
          const reviews = JSON.parse(reviewKey) as TouchedFileReview[];
          for (const review of reviews) {
            const result = await window.verbo.operations.review(review);
            if (result.ok)
              legacy.push(
                ...touchedFilesFromItems(result.items).map((file) => ({
                  path: file.path,
                  event: "write" as const,
                  available: true,
                })),
              );
          }
        }
        if (!cancelled) setLoaded({ key, receipts, legacy });
      } catch {
        if (!cancelled)
          setLoaded({
            key,
            receipts: [],
            legacy: [],
            error: "Operation details could not be loaded.",
          });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [key, receiptKey, reviewKey, threadId]);
  const current = loaded?.key === key ? loaded : null;
  const resources = new Map<string, CommandResource>();
  for (const resource of current?.receipts.flatMap(
    (receipt) => receipt.resources,
  ) ?? [])
    resources.set(resource.path, resource);
  if (!receiptKey) {
    for (const file of scan.files)
      resources.set(file.path, {
        path: file.path,
        event: "write",
        available: true,
      });
    for (const resource of current?.legacy ?? [])
      resources.set(resource.path, resource);
  }
  const files = [...resources.values()];
  const mediaParts = parts.flatMap((part, index) =>
    part.type === "file" || part.type === "image"
      ? [{ index, key: `part:${index}` }]
      : [],
  );
  const entries = [
    ...files.map((resource) => ({
      resource,
      key: `resource:${resource.path}`,
    })),
    ...mediaParts,
  ];
  if (entries.length === 0 && (!receiptKey || current) && !current?.error)
    return null;
  const onIntent = (intent: FileSurfaceIntent, path: string): void => {
    void window.verbo.files
      .surface({ path, intent })
      .then((result) => {
        if (!result.ok) notify({ message: result.summary, tone: "error" });
        else if (intent === "copy")
          notify({ id: "file-copied", message: "Copied.", tone: "success" });
      })
      .catch(() => notify({ message: "File action failed.", tone: "error" }));
  };
  const renderRows = (start: number, end: number): ReactElement[] =>
    entries.slice(start, end).map((entry) =>
      "resource" in entry ? (
        <ResourceRow
          key={entry.key}
          resource={entry.resource}
          onIntent={onIntent}
        />
      ) : (
        <MessagePrimitive.PartByIndex
          key={entry.key}
          index={entry.index}
          components={{
            File: MessageFileAttachment,
            Image: MessageImageAttachment,
          }}
        />
      ),
    );
  return (
    <section className={styles.row} aria-label="Attachments">
      {entries.length > 0 ? (
        <Group className={styles.heading} justify="space-between" gap="xs">
          <Text size="xs" fw={500} c="dimmed">
            Attachments · {entries.length}
          </Text>
          {entries.length > 4 ? (
            <Button
              size="compact-xs"
              variant="subtle"
              aria-haspopup="dialog"
              onClick={() => {
                setPage(1);
                setShowAll(true);
              }}
            >
              See all ({entries.length})
            </Button>
          ) : null}
        </Group>
      ) : null}
      {!current && receiptKey ? (
        <StatusMessage display="plain" size="xs" tone="info">
          Loading operation details…
        </StatusMessage>
      ) : null}
      {renderRows(0, 4)}
      <Modal
        opened={showAll}
        onClose={() => setShowAll(false)}
        title={`Attachments (${entries.length})`}
        size="lg"
        centered
      >
        <ScrollArea.Autosize mah="60dvh" type="auto" scrollbars="y">
          <div className={styles.fileList}>
            {renderRows((page - 1) * 40, page * 40)}
          </div>
        </ScrollArea.Autosize>
        {entries.length > 40 ? (
          <Group justify="center" mt="sm">
            <Pagination
              total={Math.ceil(entries.length / 40)}
              value={page}
              onChange={setPage}
              size="sm"
            />
          </Group>
        ) : null}
      </Modal>
      {current?.error ? (
        <StatusMessage display="plain" size="xs" tone="error">
          {current.error}
        </StatusMessage>
      ) : null}
    </section>
  );
}
