import { FolderCheckIcon, FolderPlusIcon, Trash2Icon } from "lucide-react";
import { Button, Group, Select, Switch, Text, TextInput } from "@mantine/core";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  type ReactElement,
} from "react";
import {
  displayFinalPath,
  scopeAliasListSchema,
  type FileScopeRecord,
  type FileScopeProposal,
  type ScopePatch,
  type FolderKind,
} from "@shared/files";
import {
  useSettingsAutosave,
  useSettingsDraft,
  useSettingsRef,
} from "@/hooks/use-settings-draft";
import { SettingsLabel } from "./SettingsLabel";
import { SettingsSection } from "./SettingsSection";
import { AutosaveStatus } from "./AutosaveStatus";
import { StatusMessage } from "./StatusMessage";
import { useConfirmation } from "./confirmation-context";
import styles from "./FileSettings.module.css";

function FolderRow({
  scope,
  reload,
}: {
  scope: FileScopeRecord;
  reload: () => void;
}): ReactElement {
  const key = `folder/${scope.id}/`;
  const [draft, setDraft] = useSettingsDraft(key + "draft", {
    alias: scope.aliases.join(", "),
    write: scope.write,
    defaultSave: scope.defaultSave,
    kind: scope.kind ?? "none",
    routingDescription: scope.routingDescription ?? "",
  });
  const [aliasError, setAliasError] = useSettingsDraft(key + "error", "");
  const confirm = useConfirmation();
  const baselineRef = useSettingsRef(key + "baseline", JSON.stringify(draft));
  const draftRef = useSettingsRef(key + "current", draft);
  const autosave = useSettingsAutosave<ScopePatch>(
    key + "save",
    async (patch) => {
      const result = await window.verbo.files.update(patch);
      if (!result.ok) throw new Error(result.summary);
      const saved = result.scopes.find((item) => item.id === scope.id);
      if (saved)
        baselineRef.current = JSON.stringify({
          alias: saved.aliases.join(", "),
          write: saved.write,
          defaultSave: saved.defaultSave,
          kind: saved.kind ?? "none",
          routingDescription: saved.routingDescription ?? "",
        });
      window.dispatchEvent(new Event("verbo:entities-changed"));
      reload();
    },
    (previous, next) => ({ ...previous, ...next }),
  );
  const synchronize = useEffectEvent(() => {
    if (autosave.state.status === "saving" || autosave.state.status === "error")
      return;
    const next = {
      alias: scope.aliases.join(", "),
      write: scope.write,
      defaultSave: scope.defaultSave,
      kind: scope.kind ?? "none",
      routingDescription: scope.routingDescription ?? "",
    };
    if (JSON.stringify(draftRef.current) === baselineRef.current) {
      draftRef.current = next;
      setDraft(next);
      baselineRef.current = JSON.stringify(next);
    }
  });
  useEffect(() => {
    synchronize();
  }, [scope]);
  const patch = (value: Partial<typeof draft>): void => {
    const next = { ...draftRef.current, ...value };
    draftRef.current = next;
    setDraft(next);
    autosave.controller.schedule({ id: scope.id, ...value });
  };
  return (
    <li className={styles.entry}>
      <Group align="flex-start" grow>
        <TextInput
          label={
            <SettingsLabel
              label="Aliases"
              tip="Short lowercase folder names, separated by commas. Valid edits save automatically."
            />
          }
          value={draft.alias}
          error={aliasError}
          onChange={(event) => {
            const alias = event.currentTarget.value.toLowerCase();
            const next = { ...draftRef.current, alias };
            draftRef.current = next;
            setDraft(next);
            const parsed = scopeAliasListSchema.safeParse(alias);
            if (parsed.success) {
              setAliasError("");
              autosave.controller.schedule({
                id: scope.id,
                alias: parsed.data,
              });
            }
          }}
          onBlur={() => {
            const parsed = scopeAliasListSchema.safeParse(draft.alias);
            setAliasError(
              parsed.success
                ? ""
                : (parsed.error.issues[0]?.message ?? "Check the aliases."),
            );
            void autosave.controller.flush();
          }}
        />
        <Select
          label={
            <SettingsLabel
              label="Folder type"
              tip="Projects imports folders with package.json or AGENTS.md in the first two child levels. Obsidian marks a vault; normal folders have no special role."
            />
          }
          data={[
            { value: "none", label: "Nothing in particular" },
            { value: "projects", label: "Projects folder" },
            { value: "obsidian", label: "Obsidian vault" },
          ]}
          value={draft.kind}
          allowDeselect={false}
          onChange={(value) => {
            if (value) patch({ kind: value as FolderKind });
          }}
        />
      </Group>
      <TextInput
        label="Routing description"
        description="Help Verbo recognize what belongs here. Up to 1,000 characters."
        maxLength={1000}
        value={draft.routingDescription}
        onChange={(event) =>
          patch({ routingDescription: event.currentTarget.value })
        }
        onBlur={() => void autosave.controller.flush()}
      />
      <Text className={styles.path} size="xs">
        {displayFinalPath(scope.path)}
      </Text>
      <Group gap="md">
        <Switch
          label={
            <SettingsLabel
              label="Write"
              tip="Allow changing files in this folder. Read access is included."
            />
          }
          checked={draft.write}
          onChange={(event) =>
            patch({
              write: event.currentTarget.checked,
              ...(!event.currentTarget.checked ? { defaultSave: false } : {}),
            })
          }
        />
        <Switch
          label={
            <SettingsLabel
              label="Default save"
              tip="Bare filenames are saved here. Write must be enabled."
            />
          }
          disabled={!draft.write}
          checked={draft.defaultSave}
          onChange={(event) =>
            patch({ defaultSave: event.currentTarget.checked })
          }
        />
        <Button
          leftSection={<Trash2Icon aria-hidden size={16} />}
          variant="subtle"
          color="red"
          size="xs"
          onClick={() =>
            void confirm({
              title: "Remove folder?",
              message: `Remove ${scope.alias} from registered folders? Files and imported projects will remain.`,
              confirmLabel: "Remove folder",
              destructive: true,
              onConfirm: async () => {
                await autosave.controller.reset();
                const result = await window.verbo.files.commit({
                  removeIds: [scope.id],
                  updates: [],
                  picks: [],
                  acceptDefault: false,
                });
                if (!result.ok) throw new Error(result.summary);
                reload();
              },
            })
          }
        >
          Remove folder
        </Button>
      </Group>
      <AutosaveStatus
        state={autosave.state}
        retry={() => autosave.controller.retry()}
      />
    </li>
  );
}

export function FileSettings(): ReactElement {
  const [scopes, setScopes] = useState<FileScopeRecord[]>([]);
  const [proposal, setProposal] = useSettingsDraft<FileScopeProposal | null>(
    "files/proposal",
    null,
  );
  const [busy, setBusy] = useSettingsDraft("files/busy", false);
  const [error, setError] = useSettingsDraft("files/error", "");
  const [notice, setNotice] = useSettingsDraft("files/notice", "");
  const load = useCallback((): void => {
    void window.verbo.files
      .list()
      .then((result) => {
        setScopes(result.scopes);
        setProposal(result.proposal);
      })
      .catch(() => setError("Could not load folders."));
  }, [setScopes, setProposal, setError]);
  useEffect(load, [load]);
  const add = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const pick = await window.verbo.files.pick();
      if (!pick.ok) {
        if (pick.code !== "cancelled") setError(pick.summary);
        return;
      }
      const used = new Set(scopes.flatMap((scope) => scope.aliases));
      let alias = pick.suggestedAlias;
      let suffix = 2;
      while (used.has(alias))
        alias = `${pick.suggestedAlias.slice(0, 25)}-${suffix++}`;
      const result = await window.verbo.files.commit({
        removeIds: [],
        updates: [],
        picks: [
          {
            pickId: pick.pickId,
            alias,
            read: true,
            write: false,
            defaultSave: false,
            kind: pick.kind,
          },
        ],
        acceptDefault: false,
      });
      if (!result.ok) throw new Error(result.summary);
      setScopes(result.scopes);
      setNotice(result.summary);
      window.dispatchEvent(new Event("verbo:entities-changed"));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not add the folder.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      title="Folders"
      description="Choose folder aliases, access and type. New folders detect project containers or Obsidian vaults automatically."
    >
      {error ? (
        <StatusMessage display="plain" tone="error">
          {error}
        </StatusMessage>
      ) : null}
      {notice ? (
        <StatusMessage display="plain" tone="info">
          {notice}
        </StatusMessage>
      ) : null}
      <Group>
        <Button
          variant="subtle"
          size="xs"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void window.verbo.files
              .refreshRouting()
              .then(() => setNotice("Folder routing inventory refreshed."))
              .catch(() =>
                setError("Routing inventory could not be refreshed."),
              )
              .finally(() => setBusy(false));
          }}
        >
          Refresh routing inventory
        </Button>
        <Button
          leftSection={<FolderPlusIcon aria-hidden size={16} />}
          loading={busy}
          onClick={() => void add()}
        >
          Add folder
        </Button>
        {proposal && !proposal.saved ? (
          <Button
            leftSection={<FolderCheckIcon aria-hidden size={16} />}
            variant="default"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void window.verbo.files
                .commit({
                  removeIds: [],
                  updates: [],
                  picks: [],
                  acceptDefault: true,
                })
                .then((result) => {
                  if (!result.ok) setError(result.summary);
                  else {
                    setScopes(result.scopes);
                    load();
                  }
                })
                .finally(() => setBusy(false));
            }}
          >
            Use .tmp for saving
          </Button>
        ) : null}
      </Group>
      {scopes.length ? (
        <ul className={styles.list}>
          {scopes.map((scope) => (
            <FolderRow key={scope.id} scope={scope} reload={load} />
          ))}
        </ul>
      ) : (
        <Text size="sm" c="dimmed">
          No folders registered.
        </Text>
      )}
    </SettingsSection>
  );
}
