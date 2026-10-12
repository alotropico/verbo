import { readFilePage, type FilePageView } from "@shared/file-page";
import { Button, Table, Text } from "@mantine/core";
import { useState, type ReactElement } from "react";
import styles from "./FilePageTable.module.css";

function sizeLabel(size: number | null): string {
  if (size === null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePageTable({
  page,
  threadId,
  onPage,
}: {
  page: FilePageView;
  threadId?: string;
  onPage?: (page: FilePageView) => void;
}): ReactElement {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className={styles.wrap}>
      {page.summary ? <Text size="sm">{page.summary}</Text> : null}
      <div className={styles.scroll}>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Path</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Size</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {page.items.map((item) => (
              <Table.Tr
                key={`${item.path}:${item.snippet ?? ""}:${item.size ?? ""}`}
              >
                <Table.Td>
                  <span className={styles.path}>{item.path}</span>
                  {item.snippet ? (
                    <span className={styles.snippet}>{item.snippet}</span>
                  ) : null}
                </Table.Td>
                <Table.Td>{item.type}</Table.Td>
                <Table.Td>{sizeLabel(item.size)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      {error ? (
        <Text className={styles.error} size="sm">
          {error}
        </Text>
      ) : null}
      {page.nextCursor && threadId && onPage ? (
        <Button
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => {
            const cursor = page.nextCursor;
            if (!cursor) return;
            setBusy(true);
            setError("");
            void window.verbo.files
              .query({
                threadId,
                actionId: "files.next",
                args: { cursor },
              })
              .then((result) => {
                const next = readFilePage(result);
                if (!next) {
                  setError(result.summary || "That page could not be read.");
                  return;
                }
                onPage(next);
              })
              .catch((caught: unknown) => {
                setError(
                  caught instanceof Error
                    ? caught.message
                    : "The next page failed.",
                );
              })
              .finally(() => setBusy(false));
          }}
        >
          Next page
        </Button>
      ) : null}
    </div>
  );
}
