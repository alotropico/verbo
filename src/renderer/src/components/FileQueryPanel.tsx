import {
  FileSearchIcon,
  FileTextIcon,
  FingerprintIcon,
  FolderOpenIcon,
  GitCompareArrowsIcon,
  ImageIcon,
  InfoIcon,
  ListChecksIcon,
  SearchIcon,
} from "lucide-react";
import { readFilePage, type FilePageView } from "@shared/file-page";
import type { FileUiAction } from "@shared/file-query";
import { isPersistedThreadId } from "@shared/thread-identity";
import { useAuiState } from "@assistant-ui/react";
import { Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { useState, type ReactElement } from "react";
import { FilePageTable } from "./FilePageTable";
import { SettingsLabel } from "./SettingsLabel";
import { StatusMessage } from "./StatusMessage";
import styles from "./FilePageTable.module.css";

export function FileQueryPanel(): ReactElement {
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const [root, setRoot] = useState("tmp:");
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [otherPath, setOtherPath] = useState("");
  const [page, setPage] = useState<FilePageView | null>(null);
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = (actionId: FileUiAction, args: Record<string, unknown>): void => {
    if (!isPersistedThreadId(threadId)) {
      setError("Open a conversation before querying files.");
      return;
    }
    setBusy(true);
    setError("");
    void window.verbo.files
      .query({ threadId, actionId, args })
      .then((result) => {
        const next = readFilePage(result);
        setPage(next);
        setDetail(next ? "" : (result.detail ?? ""));
        if (
          !next &&
          result.status !== "success" &&
          result.status !== "partial"
        ) {
          setError(result.summary || "That query failed.");
        }
      })
      .catch((caught: unknown) => {
        setPage(null);
        setDetail("");
        setError(
          caught instanceof Error ? caught.message : "The query failed.",
        );
      })
      .finally(() => setBusy(false));
  };

  const listOrSearch = (mode: "list" | "filename" | "content"): void => {
    const folder = root.trim();
    if (mode === "list") {
      run("files.list", { root: folder });
      return;
    }
    const text = query.trim();
    if (!text) {
      setError("Search needs text.");
      return;
    }
    run("files.search", {
      root: folder,
      mode,
      query: text,
    });
  };

  const onePath = (
    actionId: "files.stat" | "files.hash" | "files.inspect_image",
  ): void => {
    const target = path.trim();
    if (!target) {
      setError("That action needs a path.");
      return;
    }
    run(actionId, { paths: [target] });
  };

  return (
    <Stack gap="md">
      <Text fw={500} size="sm">
        Browse and inspect files
      </Text>
      <TextInput
        label={
          <SettingsLabel
            label="Folder"
            tip="A registered folder alias, such as tmp:, or a path within it."
          />
        }
        value={root}
        onChange={(event) => setRoot(event.currentTarget.value)}
      />
      <TextInput
        label={
          <SettingsLabel
            label="Search text"
            tip="Text to match in file names or in file contents."
          />
        }
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <Group gap="xs">
        <Button
          leftSection={<FolderOpenIcon aria-hidden size={16} />}
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => listOrSearch("list")}
        >
          List
        </Button>
        <Button
          leftSection={<FileSearchIcon aria-hidden size={16} />}
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => listOrSearch("filename")}
        >
          Search names
        </Button>
        <Button
          leftSection={<SearchIcon aria-hidden size={16} />}
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => listOrSearch("content")}
        >
          Search text
        </Button>
        <Button
          leftSection={<ListChecksIcon aria-hidden size={16} />}
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => {
            run("files.summary", { root: root.trim() });
          }}
        >
          Summary
        </Button>
      </Group>
      <TextInput
        label={
          <SettingsLabel
            label="Path"
            tip="A file reference such as tmp:/notes.md."
          />
        }
        value={path}
        onChange={(event) => setPath(event.currentTarget.value)}
      />
      <TextInput
        label={
          <SettingsLabel
            label="Compare with"
            tip="A second file path to compare with the first."
          />
        }
        value={otherPath}
        onChange={(event) => setOtherPath(event.currentTarget.value)}
      />
      <Group gap="xs">
        <Button
          leftSection={<FileTextIcon aria-hidden size={16} />}
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => {
            const target = path.trim();
            if (!target) {
              setError("Read needs a path.");
              return;
            }
            run("files.read", { path: target });
          }}
        >
          Read
        </Button>
        <Button
          leftSection={<InfoIcon aria-hidden size={16} />}
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => onePath("files.stat")}
        >
          File details
        </Button>
        <Button
          leftSection={<FingerprintIcon aria-hidden size={16} />}
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => onePath("files.hash")}
        >
          Checksum
        </Button>
        <Button
          leftSection={<ImageIcon aria-hidden size={16} />}
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => onePath("files.inspect_image")}
        >
          Inspect image
        </Button>
        <Button
          leftSection={<GitCompareArrowsIcon aria-hidden size={16} />}
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => {
            const left = path.trim();
            const right = otherPath.trim();
            if (!left || !right) {
              setError("Compare needs two paths.");
              return;
            }
            run("files.compare", { left, right });
          }}
        >
          Compare
        </Button>
      </Group>
      {error ? (
        <StatusMessage display="plain" size="xs" tone="error">
          {error}
        </StatusMessage>
      ) : null}
      {detail ? <pre className={styles.detail}>{detail}</pre> : null}
      {page && isPersistedThreadId(threadId) ? (
        <FilePageTable page={page} threadId={threadId} onPage={setPage} />
      ) : null}
    </Stack>
  );
}
