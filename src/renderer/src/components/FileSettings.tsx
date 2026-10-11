import { displayFinalPath, type FileScopeProposal } from "@shared/files";
import { Button, Switch, Text, TextInput } from "@mantine/core";
import { useState, type ReactElement } from "react";
import type { FileScopeDraft } from "./file-scope-draft";
import styles from "./FileSettings.module.css";

function uniqueAlias(alias: string, rows: readonly FileScopeDraft[]): string {
  const used = new Set(
    rows.filter((row) => !row.removed).map((row) => row.alias),
  );
  if (!used.has(alias)) return alias;
  let suffix = 2;
  let next = `${alias.slice(0, 28)}-${suffix}`.slice(0, 32);
  while (used.has(next)) {
    suffix += 1;
    next = `${alias.slice(0, 28)}-${suffix}`.slice(0, 32);
  }
  return next;
}

export function FileSettings({
  proposal,
  rows,
  error,
  onChange,
  onError,
}: {
  proposal: FileScopeProposal | null;
  rows: FileScopeDraft[];
  error: string;
  onChange: (rows: FileScopeDraft[]) => void;
  onError: (message: string) => void;
}): ReactElement {
  const [picking, setPicking] = useState(false);
  const visible = rows.filter((row) => !row.removed);
  const documentsTaken = visible.some((row) => row.alias === "documents");

  const patch = (key: string, change: Partial<FileScopeDraft>): void => {
    onChange(
      rows.map((row) => {
        if (row.key !== key) {
          return change.defaultSave ? { ...row, defaultSave: false } : row;
        }
        const next = { ...row, ...change };
        if (next.write) next.read = true;
        return next;
      }),
    );
  };

  return (
    <div className={styles.list}>
      <Text size="sm">
        Folder aliases are saved with Save. The model sees aliases such as
        notes:/, not a directory tree. Other folders stay unread until you
        select them.
      </Text>
      {error ? (
        <Text className={styles.error} size="sm">
          {error}
        </Text>
      ) : null}
      <div className={styles.actions}>
        {proposal && !proposal.saved && !documentsTaken ? (
          <Button
            type="button"
            size="xs"
            variant="default"
            onClick={() => {
              onChange([
                ...rows.map((row) => ({ ...row, defaultSave: false })),
                {
                  key: "proposed-default",
                  proposedDefault: true,
                  alias: "documents",
                  path: proposal.path,
                  read: true,
                  write: true,
                  defaultSave: true,
                  removed: false,
                },
              ]);
            }}
          >
            Use Documents/Verbo
          </Button>
        ) : null}
        <Button
          type="button"
          size="xs"
          loading={picking}
          onClick={() => {
            setPicking(true);
            onError("");
            void window.verbo.files
              .pick()
              .then((result) => {
                if (!result.ok) {
                  if (result.code !== "cancelled") onError(result.summary);
                  return;
                }
                onChange([
                  ...rows,
                  {
                    key: result.pickId,
                    pickId: result.pickId,
                    alias: uniqueAlias(result.suggestedAlias, rows),
                    path: result.path,
                    read: true,
                    write: false,
                    defaultSave: false,
                    removed: false,
                  },
                ]);
              })
              .catch((caught: unknown) => {
                onError(
                  caught instanceof Error
                    ? caught.message
                    : "Could not choose a folder.",
                );
              })
              .finally(() => setPicking(false));
          }}
        >
          Add folder
        </Button>
      </div>
      {visible.length === 0 ? (
        <Text size="sm" c="dimmed">
          No folders registered.
        </Text>
      ) : (
        <ul className={styles.list}>
          {visible.map((row) => (
            <li key={row.key} className={styles.entry}>
              <TextInput
                label="Alias"
                value={row.alias}
                onChange={(event) =>
                  patch(row.key, {
                    alias: event.currentTarget.value.toLowerCase(),
                  })
                }
              />
              <Text className={styles.path} size="xs">
                {displayFinalPath(row.path)}
              </Text>
              <div className={styles.actions}>
                <Switch
                  label="Read"
                  checked={row.read}
                  onChange={(event) =>
                    patch(row.key, {
                      read: event.currentTarget.checked,
                      write: event.currentTarget.checked ? row.write : false,
                    })
                  }
                />
                <Switch
                  label="Write"
                  checked={row.write}
                  onChange={(event) =>
                    patch(row.key, { write: event.currentTarget.checked })
                  }
                />
                <Switch
                  label="Default save"
                  checked={row.defaultSave}
                  onChange={(event) =>
                    patch(row.key, {
                      defaultSave: event.currentTarget.checked,
                    })
                  }
                />
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  onClick={() =>
                    onChange(
                      row.id
                        ? rows.map((item) =>
                            item.key === row.key
                              ? { ...item, removed: true }
                              : item,
                          )
                        : rows.filter((item) => item.key !== row.key),
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
