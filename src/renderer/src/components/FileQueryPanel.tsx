import { readFilePage, type FilePageView } from "@shared/file-page";
import type { FileUiAction } from "@shared/file-query";
import { isPersistedThreadId } from "@shared/thread-identity";
import { useAuiState } from "@assistant-ui/react";
import { Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { useState, type ReactElement } from "react";
import { FilePageTable } from "./FilePageTable";
import { SettingsLabel } from "./SettingsLabel";
import styles from "./FilePageTable.module.css";

export function FileQueryPanel(): ReactElement {
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const [root, setRoot] = useState("tmp:");
  const [depth, setDepth] = useState("1");
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [otherPath, setOtherPath] = useState("");
  const [page, setPage] = useState<FilePageView | null>(null);
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const parsedDepth = (): number | null => {
    const value = Number(depth);
    if (!Number.isInteger(value) || value < 0 || value > 8) return null;
    return value;
  };

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
    const depthValue = parsedDepth();
    if (depthValue === null) {
      setError("Depth is a whole number from 0 to 8.");
      return;
    }
    const folder = root.trim();
    if (mode === "list") {
      run("files.list", { root: folder, depth: depthValue });
      return;
    }
    const text = query.trim();
    if (!text) {
      setError("Search needs text.");
      return;
    }
    run("files.search", {
      root: folder,
      depth: depthValue,
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
            label="Subfolder depth"
            tip="0 checks this folder only. Use up to 8 to include subfolders."
          />
        }
        value={depth}
        onChange={(event) => setDepth(event.currentTarget.value)}
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
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => listOrSearch("list")}
        >
          List
        </Button>
        <Button
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => listOrSearch("filename")}
        >
          Search names
        </Button>
        <Button
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => listOrSearch("content")}
        >
          Search text
        </Button>
        <Button
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => {
            const depthValue = parsedDepth();
            if (depthValue === null) {
              setError("Depth is a whole number from 0 to 8.");
              return;
            }
            run("files.summary", { root: root.trim(), depth: depthValue });
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
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => onePath("files.stat")}
        >
          File details
        </Button>
        <Button
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => onePath("files.hash")}
        >
          Checksum
        </Button>
        <Button
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => onePath("files.inspect_image")}
        >
          Inspect image
        </Button>
        <Button
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
        <Text className={styles.error} size="sm">
          {error}
        </Text>
      ) : null}
      {detail ? <pre className={styles.detail}>{detail}</pre> : null}
      {page && isPersistedThreadId(threadId) ? (
        <FilePageTable page={page} threadId={threadId} onPage={setPage} />
      ) : null}
    </Stack>
  );
}
