import {
  displayFinalPath,
  splitScopeAliases,
  type FileScopeProposal,
} from "@shared/files";
import { Button, Switch, Text, TextInput } from "@mantine/core";
import { useState, type ReactElement } from "react";
import type { FileScopeDraft } from "./file-scope-draft";
import { SettingsLabel } from "./SettingsLabel";
import styles from "./FileSettings.module.css";

function uniqueAlias(alias: string, rows: readonly FileScopeDraft[]): string {
  const used = new Set(
    rows
      .filter((row) => !row.removed)
      .flatMap((row) => splitScopeAliases(row.alias)),
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
  const defaultTaken = visible.some((row) =>
    splitScopeAliases(row.alias).includes("tmp"),
  );

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
        Save to apply folder registrations. Verbo can read other folders, but
        file changes require a writable folder. Use .tmp as the default save
        folder.
      </Text>
      {error ? (
        <Text className={styles.error} size="sm">
          {error}
        </Text>
      ) : null}
      <div className={styles.actions}>
        {proposal && !proposal.saved && !defaultTaken ? (
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
                  alias: proposal.alias,
                  path: proposal.path,
                  read: true,
                  write: true,
                  defaultSave: true,
                  removed: false,
                },
              ]);
            }}
          >
            Use .tmp
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
                label={
                  <SettingsLabel
                    label="Alias"
                    tip="Short names used in file paths, separated by commas, such as tmp, scratch."
                  />
                }
                placeholder="tmp, scratch"
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
                  label={
                    <SettingsLabel
                      label="Read"
                      tip="Allow listing and reading files in this folder."
                    />
                  }
                  checked={row.read}
                  onChange={(event) =>
                    patch(row.key, {
                      read: event.currentTarget.checked,
                      write: event.currentTarget.checked ? row.write : false,
                    })
                  }
                />
                <Switch
                  label={
                    <SettingsLabel
                      label="Write"
                      tip="Allow changing files in this folder."
                    />
                  }
                  checked={row.write}
                  onChange={(event) =>
                    patch(row.key, { write: event.currentTarget.checked })
                  }
                />
                <Switch
                  label={
                    <SettingsLabel
                      label="Default save"
                      tip="Bare filenames are saved in this folder."
                    />
                  }
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
