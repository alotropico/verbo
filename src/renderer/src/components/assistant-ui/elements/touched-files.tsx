import { useEffect, useRef, useState, type ReactElement } from "react";
import { Menu, UnstyledButton } from "@mantine/core";
import { useAuiState } from "@assistant-ui/react";
import { CopyIcon, FileIcon, FolderOpenIcon } from "lucide-react";
import type { FileSurfaceIntent } from "@shared/file-surface";
import {
  touchedFilesFromItems,
  touchedFilesFromParts,
  type TouchedFile,
} from "@shared/touched-files";
import styles from "./touched-files.module.css";

function revealLabel(): string {
  const platform = navigator.platform;
  if (/mac/i.test(platform)) return "Show in Finder";
  if (/win/i.test(platform)) return "Show in Explorer";
  return "Show in folder";
}

function mergeFiles(
  inline: readonly TouchedFile[],
  reviewed: readonly TouchedFile[] | null,
): TouchedFile[] {
  if (!reviewed) return [...inline];
  const seen = new Set(inline.map((file) => file.path));
  return [...inline, ...reviewed.filter((file) => !seen.has(file.path))];
}

function TouchedFileChip({
  file,
  onIntent,
}: {
  file: TouchedFile;
  onIntent: (intent: FileSurfaceIntent, path: string) => void;
}): ReactElement {
  return (
    <Menu>
      <Menu.ContextMenu>
        <UnstyledButton
          className={styles.chip}
          title={file.path}
          aria-label={`Open ${file.name}`}
          onClick={() => onIntent("open", file.path)}
        >
          <FileIcon className={styles.icon} size={14} aria-hidden />
          <span className={styles.name}>{file.name}</span>
        </UnstyledButton>
      </Menu.ContextMenu>
      <Menu.Dropdown>
        <Menu.Item
          leftSection={<FileIcon size={14} />}
          onClick={() => onIntent("open", file.path)}
        >
          Open
        </Menu.Item>
        <Menu.Item
          leftSection={<FolderOpenIcon size={14} />}
          onClick={() => onIntent("reveal", file.path)}
        >
          {revealLabel()}
        </Menu.Item>
        <Menu.Item
          leftSection={<CopyIcon size={14} />}
          onClick={() => onIntent("copy", file.path)}
        >
          Copy content
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

export function TouchedFiles(): ReactElement | null {
  const parts = useAuiState((state) => state.message.parts);
  const scan = touchedFilesFromParts(parts);
  const reviewKey = scan.reviews
    .map((review) => `${review.operationId}:${review.threadId}`)
    .join("|");
  const reviewsRef = useRef(scan.reviews);
  reviewsRef.current = scan.reviews;
  const [reviewed, setReviewed] = useState<{
    key: string;
    files: TouchedFile[];
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (reviewKey === "" || !window.verbo?.operations) return;
    let cancelled = false;
    void Promise.all(
      reviewsRef.current.map((review) =>
        window.verbo.operations
          .review(review)
          .then((next) => (next.ok ? touchedFilesFromItems(next.items) : []))
          .catch(() => []),
      ),
    ).then((groups) => {
      if (!cancelled) setReviewed({ key: reviewKey, files: groups.flat() });
    });
    return () => {
      cancelled = true;
    };
  }, [reviewKey]);

  const files = mergeFiles(
    scan.files,
    reviewed?.key === reviewKey ? reviewed.files : null,
  );
  if (files.length === 0) return null;

  const onIntent = (intent: FileSurfaceIntent, path: string): void => {
    setNotice(null);
    if (!window.verbo?.files?.surface) {
      setNotice("File actions are unavailable.");
      return;
    }
    void window.verbo.files.surface({ path, intent }).then((result) => {
      if (!result.ok) setNotice(result.summary);
      else if (intent === "copy") setNotice("Copied.");
    });
  };

  return (
    <div className={styles.row} role="group" aria-label="Changed files">
      {files.map((file) => (
        <TouchedFileChip file={file} key={file.path} onIntent={onIntent} />
      ))}
      {notice ? <p className={styles.notice}>{notice}</p> : null}
    </div>
  );
}
