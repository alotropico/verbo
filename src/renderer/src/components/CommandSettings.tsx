import { useSettingsSession } from "@/hooks/settings-session-context";
import { useSettingsDraft } from "@/hooks/use-settings-draft";
import { useSettingsResource } from "@/hooks/use-settings-resource";
import { Button, Group, NavLink, Stack, Text } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { type CommandSettings as CommandSettingsData } from "@shared/commands";
import {
  AppWindowIcon,
  BookmarkIcon,
  FolderIcon,
  FolderOpenIcon,
  GlobeIcon,
  ListTreeIcon,
  NotebookIcon,
  RefreshCwIcon,
  Settings2Icon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import styles from "./ActionsSettings.module.css";
import { CommandTable } from "./CommandTable";
import { EntityCommandSettings } from "./EntityCommandSettings";
import { MemorySettings } from "./MemorySettings";
import { useSettingsNavigation } from "./settings-navigation-context";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { StatusMessage } from "./StatusMessage";
import { SettingsLoading } from "./SettingsLoading";
import { FileSettings } from "./FileSettings";

const MODULES: Record<string, { title: string; icon: LucideIcon }> = {
  general: { title: "All commands", icon: ListTreeIcon },
  web: { title: "Web", icon: GlobeIcon },
  memory: { title: "Memory", icon: BookmarkIcon },
  files: { title: "Files", icon: FolderIcon },
  software: { title: "Applications", icon: AppWindowIcon },
  projects: { title: "Projects", icon: FolderOpenIcon },
  environment: { title: "Environment", icon: Settings2Icon },
  ags: { title: "AGS", icon: TerminalIcon },
  obsidian: { title: "Obsidian", icon: NotebookIcon },
};

export function CommandSettings({ ags, history, files }: { ags?: ReactNode; history?: ReactNode; files?: ReactNode }): ReactElement {
  const {
    data,
    loading,
    error,
    reload: load,
  } = useSettingsResource<CommandSettingsData>("commands", () => window.verbo.commands.settings());
  const { module: selected, selectModule } = useSettingsNavigation();
  const session = useSettingsSession();
  const [epochs, setEpochs] = useSettingsDraft<Record<string, number>>("commands/epochs", {});
  const resetAliases = async (ids: string[]): Promise<void> => {
    for (const id of ids) await session.resetAutosaves(`command-alias/${id}/`);
  };
  const [settingsOpen, setSettingsOpen] = useLocalStorage({
    key: "verbo:command-settings:settings-open",
    defaultValue: true,
    getInitialValueInEffect: false,
  });
  const [commandsOpen, setCommandsOpen] = useLocalStorage({
    key: "verbo:command-settings:commands-open",
    defaultValue: false,
    getInitialValueInEffect: false,
  });
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [selected]);
  const modules = data?.nodes.filter((node) => !node.id.includes(".")) ?? [];
  const moduleId = selected;
  const { title, icon: Icon } = MODULES[moduleId] ?? {
    title: moduleId,
    icon: TerminalIcon,
  };
  const count = data?.nodes.filter((node) => moduleId === "general" || node.id === moduleId || node.id.startsWith(`${moduleId}.`)).length;

  const restored = (id: string): void => {
    for (const node of data?.nodes ?? []) if (node.id === id || node.id.startsWith(`${id}.`)) session.clear(`command-alias/${node.id}/`);
    setEpochs((previous) => ({
      ...previous,
      ...Object.fromEntries(
        (data?.nodes ?? [])
          .filter((node) => node.id === id || node.id.startsWith(`${id}.`))
          .map((node) => [node.id, (previous[node.id] ?? 0) + 1]),
      ),
    }));
  };
  const select = (id: string): void => {
    selectModule(id);
    contentRef.current?.scrollTo({ top: 0 });
  };
  if (!data) return <SettingsLoading label="Loading command modules…" error={error} retry={() => void load()} />;
  return (
    <div className={styles.commandsLayout} aria-busy={loading}>
      <nav aria-label="Command modules" className={styles.commandsNav}>
        {[{ id: "general" }, ...modules].map((module) => {
          const { title, icon: Icon } = MODULES[module.id] ?? {
            title: module.id,
            icon: TerminalIcon,
          };
          return (
            <NavLink
              component="button"
              type="button"
              key={module.id}
              className={styles.moduleLink}
              leftSection={<Icon size={16} aria-hidden />}
              label={title}
              active={selected === module.id}
              aria-current={selected === module.id ? "page" : undefined}
              onClick={(event) => {
                select(module.id);
                event.currentTarget.scrollIntoView({
                  block: "nearest",
                  inline: "nearest",
                });
              }}
            />
          );
        })}
      </nav>
      <div ref={contentRef} className={styles.commandsContent}>
        {error ? (
          <StatusMessage display="outline" size="sm" tone="error">
            {error}
          </StatusMessage>
        ) : null}
        {loading ? <SettingsLoading label="Refreshing commands…" /> : null}
        <Stack key={moduleId} gap="md" aria-label={`${MODULES[moduleId]?.title ?? moduleId} settings`}>
          <Group className={styles.moduleHeading} justify="space-between" align="flex-start">
            <Stack gap={4} className={styles.moduleIntroduction}>
              <Group gap="sm" wrap="nowrap">
                <Icon size={20} aria-hidden className={styles.moduleIcon} />
                <Text component="h3" size="lg" fw={500} m={0}>
                  {moduleId === "general" ? "All commands" : title}
                </Text>
              </Group>
              <Text size="sm" c="dimmed">
                {moduleId === "general"
                  ? "Manage command aliases across every module."
                  : modules.find((module) => module.id === moduleId)?.description}
              </Text>
            </Stack>
            <Group gap="sm">
              <Button
                size="xs"
                variant="default"
                leftSection={<RefreshCwIcon size={14} aria-hidden />}
                disabled={loading}
                onClick={() => void load()}
              >
                Refresh commands
              </Button>
              {count !== undefined ? (
                <Text size="xs" c="dimmed" className={styles.moduleCount}>
                  {count} {count === 1 ? "command" : "commands"}
                </Text>
              ) : null}
            </Group>
          </Group>
          {moduleId === "general" ? (
            <>
              {data ? (
                <CommandTable data={data} reload={load} resetAliases={resetAliases} epochs={epochs} onRestored={restored} />
              ) : (
                <Text size="sm" c="dimmed">
                  Loading commands…
                </Text>
              )}
              {history}
            </>
          ) : (
            <>
              <SettingsDisclosure
                title={
                  <Group component="span" gap="xs" wrap="nowrap">
                    <Settings2Icon size={16} aria-hidden />
                    <span>Other settings</span>
                  </Group>
                }
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
              >
                {!["memory", "files", "software", "projects", "ags", "obsidian"].includes(moduleId) ? (
                  <Text size="sm" c="dimmed">
                    No additional settings for this module. Open Commands to manage its aliases and view usage details.
                  </Text>
                ) : null}
                {moduleId === "memory" ? <MemorySettings /> : null}
                {moduleId === "files" ? files : null}
                {moduleId === "obsidian" ? <FileSettings kind="obsidian" /> : null}
                {moduleId === "ags" ? ags : null}
                {moduleId === "projects" || moduleId === "software" ? <EntityCommandSettings module={moduleId} /> : null}
              </SettingsDisclosure>
              <SettingsDisclosure
                title={
                  <Group component="span" gap="xs" wrap="nowrap">
                    <TerminalIcon size={16} aria-hidden />
                    <span>Commands</span>
                  </Group>
                }
                open={commandsOpen}
                onOpenChange={setCommandsOpen}
              >
                {data ? (
                  <CommandTable
                    moduleId={moduleId}
                    data={data}
                    reload={load}
                    resetAliases={resetAliases}
                    epochs={epochs}
                    onRestored={restored}
                  />
                ) : (
                  <Text size="sm" c="dimmed">
                    Loading commands…
                  </Text>
                )}
              </SettingsDisclosure>
            </>
          )}
        </Stack>
      </div>
    </div>
  );
}
