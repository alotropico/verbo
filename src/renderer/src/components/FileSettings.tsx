import { FolderCheckIcon, FolderPlusIcon, Trash2Icon } from "lucide-react";
import { Button, Group, Select, Switch, Text, TextInput } from "@mantine/core";
import { useEffect, useEffectEvent, type ReactElement } from "react";
import { displayFinalPath, scopeAliasListSchema, type FileScopeRecord, type ScopePatch, type FolderKind } from "@shared/files";
import { useSettingsAutosave, useSettingsDraft, useSettingsRef } from "@/hooks/use-settings-draft";
import { useSettingsResource } from "@/hooks/use-settings-resource";
import { LONG_TEXT_SAVE_DELAY } from "@/runtime/autosave";
import { SettingsLoading } from "./SettingsLoading";
import { notify } from "@/lib/notify";
import { SettingsLabel } from "./SettingsLabel";
import { SettingsSection } from "./SettingsSection";
import { AutosaveStatus } from "./AutosaveStatus";
import { StatusMessage } from "./StatusMessage";
import { useConfirmation } from "./confirmation-context";
import styles from "./FileSettings.module.css";

function FolderRow({ scope, reload }: { scope: FileScopeRecord; reload: () => void }): ReactElement {
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
    },
    (previous, next) => ({ ...previous, ...next }),
    {
      id: scope.id,
      alias: scope.aliases.join(", "),
      write: scope.write,
      defaultSave: scope.defaultSave,
      kind: scope.kind ?? "none",
      routingDescription: scope.routingDescription ?? "",
    },
  );
  const synchronize = useEffectEvent(() => {
    if (autosave.state.status === "saving" || autosave.state.status === "error") return;
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
      autosave.controller.acceptBaseline({ id: scope.id, ...next });
    }
  });
  useEffect(() => {
    synchronize();
  }, [scope]);
  const patch = (value: Partial<typeof draft>, delay?: number): void => {
    const next = { ...draftRef.current, ...value };
    draftRef.current = next;
    setDraft(next);
    autosave.controller.schedule({ id: scope.id, ...value }, delay);
  };
  return (
    <li className={styles.entry}>
      <Group align="flex-start" grow>
        <TextInput
          label={<SettingsLabel label="Aliases" tip="Short lowercase folder names, separated by commas. Valid edits save automatically." />}
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
            setAliasError(parsed.success ? "" : (parsed.error.issues[0]?.message ?? "Check the aliases."));
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
        onChange={(event) => patch({ routingDescription: event.currentTarget.value }, LONG_TEXT_SAVE_DELAY)}
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
              tip="Allow Verbo and its agent to create and change files here, including notes in Obsidian vaults. Read access is included."
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
          label={<SettingsLabel label="Default save" tip="Bare filenames are saved here. Write must be enabled." />}
          disabled={!draft.write}
          checked={draft.defaultSave}
          onChange={(event) => patch({ defaultSave: event.currentTarget.checked })}
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
      <AutosaveStatus state={autosave.state} retry={() => autosave.controller.retry()} />
    </li>
  );
}

export function FileSettings({ kind }: { kind?: FolderKind } = {}): ReactElement {
  const { data, loading, error: loadError, reload: load } = useSettingsResource("files", () => window.verbo.files.list());
  const scopes = data?.scopes ?? [];
  const shownScopes = kind ? scopes.filter((scope) => scope.kind === kind) : scopes;
  const proposal = data?.proposal;
  const [busy, setBusy] = useSettingsDraft("files/busy", false);
  const [error, setError] = useSettingsDraft("files/error", "");
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
      while (used.has(alias)) alias = `${pick.suggestedAlias.slice(0, 25)}-${suffix++}`;
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
            kind: kind ?? pick.kind,
          },
        ],
        acceptDefault: false,
      });
      if (!result.ok) throw new Error(result.summary);
      notify({ message: result.summary, tone: "success" });
      window.dispatchEvent(new Event("verbo:entities-changed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the folder.");
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <SettingsLoading label="Loading folders…" error={loadError} retry={() => void load()} />;
  return (
    <SettingsSection
      title={kind === "obsidian" ? "Vault folders" : "Folders"}
      description={
        kind === "obsidian"
          ? "Enable Write for each vault to allow note changes. Notes use the same folder permissions as other files. Moves and renames do not rewrite note links."
          : "Choose folder aliases, access and type. Write allows Verbo and its agent to change files inside that folder."
      }
    >
      {loading || loadError ? <SettingsLoading label="Refreshing folders…" error={loadError} retry={() => void load()} /> : null}
      {error ? (
        <StatusMessage display="plain" tone="error">
          {error}
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
              .then(() =>
                notify({
                  message: "Folder routing inventory refreshed.",
                  tone: "success",
                }),
              )
              .catch(() => setError("Routing inventory could not be refreshed."))
              .finally(() => setBusy(false));
          }}
        >
          Refresh routing inventory
        </Button>
        <Button leftSection={<FolderPlusIcon aria-hidden size={16} />} loading={busy} onClick={() => void add()}>
          {kind === "obsidian" ? "Add vault folder" : "Add folder"}
        </Button>
        {!kind && proposal && !proposal.saved ? (
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
                    window.dispatchEvent(new Event("verbo:entities-changed"));
                  }
                })
                .finally(() => setBusy(false));
            }}
          >
            Use .tmp for saving
          </Button>
        ) : null}
      </Group>
      {shownScopes.length ? (
        <ul className={styles.list}>
          {shownScopes.map((scope) => (
            <FolderRow key={scope.id} scope={scope} reload={load} />
          ))}
        </ul>
      ) : (
        <Text size="sm" c="dimmed">
          {kind === "obsidian" ? "No vault folders registered. Add a vault folder, then enable Write." : "No folders registered."}
        </Text>
      )}
    </SettingsSection>
  );
}
