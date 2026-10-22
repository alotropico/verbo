import { FolderPlusIcon, TerminalIcon, Trash2Icon, XCircleIcon } from "lucide-react";
import { useConfirmation } from "./confirmation-context";
import { scopeAliasSchema } from "@shared/files";
import { Button, Text, TextInput } from "@mantine/core";
import { type ReactElement, type ReactNode } from "react";
import { CommandSettings } from "./CommandSettings";
import { SettingsLabel } from "./SettingsLabel";
import { StatusMessage } from "./StatusMessage";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { SettingsSection } from "./SettingsSection";
import styles from "./ActionsSettings.module.css";
import { useSettingsDraft } from "@/hooks/use-settings-draft";
import { useSettingsResource } from "@/hooks/use-settings-resource";
import { SettingsLoading } from "./SettingsLoading";

function aliasOrError(value: string): string | null {
  const parsed = scopeAliasSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function ActionsSettings({ files }: { files?: ReactNode }): ReactElement {
  return <CommandSettings ags={<AgsSettings />} history={<RecentActions />} files={files} />;
}

function AgsSettings(): ReactElement {
  const confirm = useConfirmation();
  const {
    data: overview,
    loading,
    error: loadError,
    reload: load,
  } = useSettingsResource("overview", () => window.verbo.actions.overview());
  const [error, setError] = useSettingsDraft("ags/error", "");
  const [hostAlias, setHostAlias] = useSettingsDraft("ags/host-alias", "");
  const [busy, setBusy] = useSettingsDraft("ags/busy", false);

  const addRoot = (
    alias: string,
    add: (input: { pickId: string; alias: string }) => Promise<{ ok: boolean; summary: string }>,
    clear: () => void,
  ): void => {
    const parsed = aliasOrError(alias);
    if (!parsed) {
      setError("Use a short lowercase alias.");
      return;
    }
    setBusy(true);
    void window.verbo.files
      .pick()
      .then(async (pick) => {
        if (!pick.ok) {
          setError(pick.code === "cancelled" ? "" : pick.summary);
          return;
        }
        const saved = await add({ pickId: pick.pickId, alias: parsed });
        if (!saved.ok) {
          setError(saved.summary);
          return;
        }
        clear();
        load();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "Could not add.");
      })
      .finally(() => setBusy(false));
  };

  if (!overview) return <SettingsLoading label="Loading AGS registrations…" error={loadError} retry={() => void load()} />;
  return (
    <SettingsSection title="AGS repositories" description="Configure the AGS executable and register repository roots.">
      {loading || loadError ? <SettingsLoading label="Refreshing AGS registrations…" error={loadError} retry={() => void load()} /> : null}
      {error ? (
        <StatusMessage display="plain" size="sm" tone="error">
          {error}
        </StatusMessage>
      ) : null}
      {!overview && !error ? (
        <StatusMessage display="plain" size="sm" tone="info">
          Loading registrations…
        </StatusMessage>
      ) : null}
      <Text size="sm">
        {overview?.agsCheckConfigured
          ? `Check command: ${overview.agsCheckPath}`
          : "No allowlisted ags executable is configured. ags.check stays unavailable."}
      </Text>
      <div className={styles.row}>
        <Button
          leftSection={<TerminalIcon aria-hidden size={16} />}
          type="button"
          size="xs"
          variant="default"
          onClick={() => {
            void window.verbo.ags.chooseCheck().then((result) => {
              if (!result.ok) setError(result.summary);
              else load();
            });
          }}
        >
          Choose ags executable
        </Button>
        <Button
          leftSection={<XCircleIcon aria-hidden size={16} />}
          type="button"
          size="xs"
          variant="default"
          onClick={() => {
            void confirm({
              title: "Clear AGS check command?",
              message: "Remove the configured AGS executable?",
              confirmLabel: "Clear command",
              onConfirm: async () => {
                await window.verbo.ags.clearCheck();
                load();
              },
            });
          }}
        >
          Clear check command
        </Button>
      </div>
      <div className={styles.row}>
        <TextInput
          className={styles.aliasField}
          label={<SettingsLabel label="Host alias" tip="Name for an AGS repository root." />}
          value={hostAlias}
          onChange={(event) => setHostAlias(event.currentTarget.value)}
        />
        <Button
          leftSection={<FolderPlusIcon aria-hidden size={16} />}
          type="button"
          size="xs"
          variant="default"
          loading={busy}
          onClick={() => addRoot(hostAlias, window.verbo.ags.addHost, () => setHostAlias(""))}
        >
          Add AGS host
        </Button>
      </div>
      <ul className={styles.roots}>
        {overview?.agsHosts.map((host) => (
          <li className={styles.row} key={host.id}>
            <Text size="sm">{host.alias}</Text>
            <Text className={styles.path} size="xs">
              {host.path}
            </Text>
            <Button
              leftSection={<Trash2Icon aria-hidden size={16} />}
              type="button"
              size="xs"
              variant="default"
              onClick={() => {
                void confirm({
                  title: "Remove AGS host?",
                  message: `Remove ${host.alias} from registered repositories?`,
                  confirmLabel: "Remove host",
                  destructive: true,
                  onConfirm: async () => {
                    const result = await window.verbo.ags.removeHost(host.id);
                    if (!result.ok) throw new Error(result.summary);
                    load();
                  },
                });
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}

function RecentActions(): ReactElement {
  const [opened, setOpened] = useSettingsDraft("commands/history-open", false);
  const { data: overview, error, reload } = useSettingsResource("overview", () => window.verbo.actions.overview(), opened);
  const history = overview?.history.slice(0, 12) ?? [];
  return (
    <SettingsDisclosure title="Recent actions" open={opened} onOpenChange={setOpened}>
      {!overview ? (
        <SettingsLoading label="Loading recent actions…" error={error} retry={() => void reload()} />
      ) : (
        <>
          {history.length === 0 ? (
            <Text size="sm">No recent actions.</Text>
          ) : (
            <ul className={styles.history}>
              {history.map((entry) => (
                <li className={styles.entry} key={`${entry.createdAt}-${entry.actionId}`}>
                  <Text className={entry.status === "error" || entry.status === "partial" ? styles.error : undefined} size="sm">
                    {entry.actionId}
                    {entry.code ? ` (${entry.code})` : ""} · {entry.status}
                  </Text>
                  <Text size="xs">{entry.summary}</Text>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </SettingsDisclosure>
  );
}
