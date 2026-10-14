import { type CommandSettings as CommandSettingsData } from "@shared/commands";
import { NavLink, Stack, Text } from "@mantine/core";
import {
  GlobeIcon,
  BrainIcon,
  FolderIcon,
  AppWindowIcon,
  FolderOpenIcon,
  Settings2Icon,
  TerminalIcon,
  SlidersHorizontalIcon,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useState,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import styles from "./ActionsSettings.module.css";
import { EntityCommandSettings } from "./EntityCommandSettings";
import { MemorySettings } from "./MemorySettings";
import { StatusMessage } from "./StatusMessage";
import { WebCommandSettings } from "./WebCommandSettings";
import { CommandTable } from "./CommandTable";
import { useSettingsNavigation } from "./settings-navigation-context";
import type { AutosaveController } from "@/runtime/autosave";
import type { WebSettings } from "@shared/web-contracts";
import { SettingsSection } from "./SettingsSection";

const MODULES: Record<string, { title: string; icon: LucideIcon }> = {
  general: { title: "General", icon: SlidersHorizontalIcon },
  web: { title: "Web", icon: GlobeIcon },
  memory: { title: "Memory", icon: BrainIcon },
  files: { title: "Files", icon: FolderIcon },
  software: { title: "Applications", icon: AppWindowIcon },
  projects: { title: "Projects", icon: FolderOpenIcon },
  environment: { title: "Environment", icon: Settings2Icon },
  ags: { title: "AGS", icon: TerminalIcon },
};

export function CommandSettings({
  general,
  files,
}: {
  general: ReactNode;
  files?: ReactNode;
}): ReactElement {
  const [data, setData] = useState<CommandSettingsData | null>(null);
  const { module: selected, selectModule } = useSettingsNavigation();
  const webController = useRef<AutosaveController<WebSettings> | null>(null);
  const [webEpoch, setWebEpoch] = useState(0);
  const [visited, setVisited] = useState(["general"]);
  const [error, setError] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async (): Promise<void> => {
    await window.verbo.commands
      .settings()
      .then((next) => {
        setData(next);
        setError("");
      })
      .catch(() => setError("Commands could not be loaded."));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!visited.includes(selected)) setVisited([...visited, selected]);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [selected]);
  const modules = data?.nodes.filter((node) => !node.id.includes(".")) ?? [];
  const select = (id: string): void => {
    selectModule(id);
    setVisited((previous) =>
      previous.includes(id) ? previous : [...previous, id],
    );
    contentRef.current?.scrollTo({ top: 0 });
  };
  return (
    <div className={styles.commandsLayout}>
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
        {visited.map((moduleId) => (
          <Stack
            key={moduleId}
            gap="lg"
            hidden={selected !== moduleId}
            className={styles.modulePanel}
            aria-label={`${MODULES[moduleId]?.title ?? moduleId} settings`}
          >
            {moduleId === "general" ? (
              general
            ) : (
              <>
                {!["memory", "files", "software", "projects", "web"].includes(
                  moduleId,
                ) ? (
                  <SettingsSection
                    title={MODULES[moduleId]?.title ?? moduleId}
                    description={
                      modules.find((module) => module.id === moduleId)
                        ?.description
                    }
                  >
                    <Text size="sm" c="dimmed">
                      Edit command aliases in the table below, or open the
                      details for usage and requirements.
                    </Text>
                  </SettingsSection>
                ) : null}
                {moduleId === "memory" ? <MemorySettings /> : null}
                {moduleId === "files" ? files : null}
                {moduleId === "projects" || moduleId === "software" ? (
                  <EntityCommandSettings module={moduleId} />
                ) : null}
                {moduleId === "web" && data ? (
                  <WebCommandSettings
                    key={webEpoch}
                    settings={data.web}
                    reload={load}
                    register={(controller) => {
                      webController.current = controller;
                    }}
                  />
                ) : null}
                {data ? (
                  <CommandTable
                    moduleId={moduleId}
                    data={data}
                    reload={load}
                    resetWeb={() =>
                      webController.current?.reset() ?? Promise.resolve()
                    }
                    onRestored={() => setWebEpoch((value) => value + 1)}
                  />
                ) : null}
              </>
            )}
          </Stack>
        ))}
      </div>
    </div>
  );
}
