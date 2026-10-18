import {
  ActionIcon,
  Button,
  Group,
  SimpleGrid,
  Stack,
  Switch,
  Tabs,
  Text,
} from "@mantine/core";
import {
  ArrowLeftIcon,
  BookmarkIcon,
  BrainCircuitIcon,
  FolderOpenIcon,
  MicIcon,
  SlidersHorizontalIcon,
  TerminalIcon,
  Volume2Icon,
} from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import type { ChatSettings } from "@shared/config";
import {
  contextChoices,
  legacyTemperatureNotice,
  sliderTemperature,
  type SettingsRecovery,
} from "@shared/settings-recovery";
import {
  DEFAULT_VOICE_SETTINGS,
  VOICE_SETTINGS_EVENT,
  type VoiceSettings,
} from "@shared/voice-settings";
import {
  useSettingsAutosave,
  useSettingsDraft,
  useSettingsRef,
} from "@/hooks/use-settings-draft";
import {
  useAdvancedExport,
  writeAdvancedExport,
} from "@/runtime/advanced-export";
import { SettingsSessionProvider } from "./SettingsSessionProvider";
import { ChoiceInput } from "./ChoiceInput";
import { SettingsLabel } from "./SettingsLabel";
import { SettingsSection } from "./SettingsSection";
import { SettingsSlider } from "./SettingsSlider";
import { ListeningSettings, SpeechSettings } from "./VoiceSettings";
import { ActionsSettings } from "./ActionsSettings";
import { FileSettings } from "./FileSettings";
import { AutosaveStatus } from "./AutosaveStatus";
import { StatusMessage } from "./StatusMessage";
import { useSettingsNavigation } from "./settings-navigation-context";
import styles from "./SettingsPanel.module.css";

export function SettingsPanel(): ReactElement {
  const { openSettings, opened } = useSettingsNavigation();
  return (
    <>
      <hr className={styles.divider} />
      <Button
        variant="default"
        radius="xl"
        fullWidth
        aria-label="Settings"
        aria-pressed={opened}
        className={styles.trigger}
        onClick={() => openSettings()}
        leftSection={<SlidersHorizontalIcon size={16} />}
      >
        Settings
      </Button>
    </>
  );
}

function ModelSettings({ report }: { report: SettingsRecovery }): ReactElement {
  const [draft, setDraft] = useSettingsDraft("model/draft", report.settings);
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState("");
  const baselineRef = useSettingsRef("model/baseline", report.settings);
  useEffect(() => {
    const changed = (event: Event): void => {
      const incoming = (event as CustomEvent<ChatSettings>).detail;
      if (!incoming) return;
      const previous = baselineRef.current;
      setDraft((current) => ({
        model:
          current.model === previous.model ? incoming.model : current.model,
        think:
          current.think === previous.think ? incoming.think : current.think,
        temperature:
          current.temperature === previous.temperature
            ? incoming.temperature
            : current.temperature,
        numCtx:
          current.numCtx === previous.numCtx ? incoming.numCtx : current.numCtx,
        keepAlive:
          current.keepAlive === previous.keepAlive
            ? incoming.keepAlive
            : current.keepAlive,
      }));
      baselineRef.current = incoming;
    };
    window.addEventListener("verbo:settings-changed", changed);
    void window.verbo.settings
      .get()
      .then((next) =>
        changed(
          new CustomEvent("verbo:settings-changed", { detail: next.settings }),
        ),
      )
      .catch(() => setError("Could not refresh model settings."));
    return () => window.removeEventListener("verbo:settings-changed", changed);
  }, [baselineRef, setDraft]);
  const autosave = useSettingsAutosave<Partial<ChatSettings>>(
    "model/save",
    async (patch) => {
      const saved = await window.verbo.settings.patch(patch);
      window.dispatchEvent(
        new CustomEvent("verbo:settings-changed", { detail: saved }),
      );
    },
    (previous, next) => ({ ...previous, ...next }),
  );
  useEffect(() => {
    void window.verbo.ollama
      .status()
      .then((status) => {
        if (status.ok) setModels(status.models);
        else setError(status.error);
      })
      .catch(() => setError("Could not list installed models."));
  }, []);
  const change = (patch: Partial<ChatSettings>): void => {
    setDraft((current) => ({ ...current, ...patch }));
    autosave.controller.schedule(patch);
  };
  const modelData = [...new Set([...models, draft.model])].map((model) => ({
    value: model,
    label:
      models.length && !models.includes(model)
        ? `${model} (not installed)`
        : model,
  }));
  const notice = legacyTemperatureNotice(report.settings.temperature);
  return (
    <SettingsSection
      title="Model behavior"
      description="Choose the model and tune how it responds."
    >
      {report.issues.map((issue) => (
        <StatusMessage key={issue} display="outline" tone="warning">
          {issue}
        </StatusMessage>
      ))}
      {notice ? (
        <StatusMessage display="outline" tone="warning">
          {notice}
        </StatusMessage>
      ) : null}
      {error ? (
        <StatusMessage display="plain" tone="error">
          {error}
        </StatusMessage>
      ) : null}
      <SimpleGrid
        type="container"
        cols={{ base: 1, "640px": 2 }}
        spacing="md"
        className={styles.formFields}
      >
        <ChoiceInput
          label={
            <SettingsLabel
              label="Model"
              tip="Choose an installed Ollama model for your conversations."
            />
          }
          data={modelData}
          allowDeselect={false}
          searchable
          nothingFoundMessage="No matching models"
          value={draft.model}
          onChange={(model) => {
            if (model) change({ model });
          }}
        />
        <ChoiceInput
          label={
            <SettingsLabel
              label="Context window"
              tip="How much conversation the model can use at once. Larger windows use more memory."
            />
          }
          data={contextChoices(draft.numCtx)}
          allowDeselect={false}
          value={String(draft.numCtx)}
          onChange={(value) => {
            if (value) change({ numCtx: Number(value) });
          }}
        />
        <Switch
          label={
            <SettingsLabel
              label="Thinking mode"
              tip="Let supported models reason before answering."
            />
          }
          checked={draft.think}
          onChange={(event) => change({ think: event.currentTarget.checked })}
        />
        <SettingsSlider
          label="Temperature"
          description="Lower values give more consistent answers. Higher values add variety."
          display={sliderTemperature(draft.temperature).toFixed(1)}
          min={0}
          max={1}
          step={0.1}
          value={sliderTemperature(draft.temperature)}
          onChange={(temperature) => change({ temperature })}
        />
      </SimpleGrid>
      <AutosaveStatus
        state={autosave.state}
        retry={() => autosave.controller.retry()}
      />
    </SettingsSection>
  );
}

function ExportSettings(): ReactElement {
  const enabled = useAdvancedExport();
  return (
    <SettingsSection
      title="Copy and export"
      description="Plain text is the default. Advanced format keeps every object in the message or chat."
    >
      <Switch
        label={
          <SettingsLabel
            label="Advanced format"
            tip="Copy and export of a message or a whole chat include parts, tool calls, results, attachments, and the latest turn's model objects as JSON."
          />
        }
        checked={enabled}
        onChange={(event) => writeAdvancedExport(event.currentTarget.checked)}
      />
    </SettingsSection>
  );
}

export function SettingsPage(): ReactElement {
  return (
    <SettingsSessionProvider>
      <SettingsWorkspace />
    </SettingsSessionProvider>
  );
}

function SettingsWorkspace(): ReactElement {
  const navigation = useSettingsNavigation();
  const [report, setReport] = useState<SettingsRecovery | null>(null);
  const [voice, setVoice] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const [error, setError] = useState("");
  const voiceAutosave = useSettingsAutosave<VoiceSettings>(
    "voice/save",
    async (value) => {
      const saved = await window.verbo.voice.setSettings(value);
      window.dispatchEvent(
        new CustomEvent(VOICE_SETTINGS_EVENT, { detail: saved }),
      );
    },
  );
  useEffect(() => {
    if (!navigation.opened || report) return;
    void Promise.all([
      window.verbo.settings.get(),
      window.verbo.voice.settings(),
    ])
      .then(([settings, voiceSettings]) => {
        setReport(settings);
        setVoice(voiceSettings);
      })
      .catch(() => setError("Could not load Settings."));
  }, [navigation.opened, report]);
  const changeVoice = (value: VoiceSettings): void => {
    setVoice(value);
    voiceAutosave.controller.schedule(value);
  };
  return (
    <section
      aria-label="Settings workspace"
      className={styles.workspace}
      hidden={!navigation.opened}
    >
      <Group justify="space-between" className={styles.workspaceHeader}>
        <Group gap="sm">
          <ActionIcon
            variant="subtle"
            aria-label="Back to chat"
            onClick={navigation.showChat}
          >
            <ArrowLeftIcon size={18} />
          </ActionIcon>
          <Text component="h2" size="xl" fw={500} m={0}>
            Settings
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          Changes save automatically
        </Text>
      </Group>
      {error ? (
        <StatusMessage display="outline" tone="error">
          {error}
        </StatusMessage>
      ) : null}
      {navigation.opened ? (
        <Tabs
          value={navigation.tab}
          onChange={(tab) => navigation.selectTab(tab ?? "model")}
          variant="pills"
          keepMounted={false}
          className={styles.tabs}
          classNames={{ list: styles.tabList, tab: styles.tab }}
        >
          <Tabs.List>
            <Tabs.Tab
              value="model"
              leftSection={<BrainCircuitIcon aria-hidden size={16} />}
            >
              Model
            </Tabs.Tab>
            <Tabs.Tab
              value="memory"
              leftSection={<BookmarkIcon aria-hidden size={16} />}
            >
              Memory
            </Tabs.Tab>
            <Tabs.Tab
              value="files"
              leftSection={<FolderOpenIcon aria-hidden size={16} />}
            >
              Files
            </Tabs.Tab>
            <Tabs.Tab
              value="listening"
              leftSection={<MicIcon aria-hidden size={16} />}
            >
              Listening
            </Tabs.Tab>
            <Tabs.Tab
              value="speech"
              leftSection={<Volume2Icon aria-hidden size={16} />}
            >
              Speech
            </Tabs.Tab>
            <Tabs.Tab
              value="actions"
              leftSection={<TerminalIcon aria-hidden size={16} />}
            >
              Commands
            </Tabs.Tab>
          </Tabs.List>
          {navigation.tab === "model" ? (
            <Tabs.Panel value="model" className={styles.panel}>
              <Stack gap="xl">
                {report ? (
                  <ModelSettings report={report} />
                ) : (
                  <Text size="sm" c="dimmed">
                    Loading model settings…
                  </Text>
                )}
                <ExportSettings />
              </Stack>
            </Tabs.Panel>
          ) : null}
          {navigation.tab === "memory" ? (
            <Tabs.Panel value="memory" className={styles.panel}>
              <Button
                variant="default"
                leftSection={<BookmarkIcon aria-hidden size={16} />}
                onClick={() => navigation.selectModule("memory")}
              >
                Open Memory in Commands
              </Button>
            </Tabs.Panel>
          ) : null}
          {navigation.tab === "files" ? (
            <Tabs.Panel value="files" className={styles.panel}>
              <Button
                variant="default"
                leftSection={<FolderOpenIcon aria-hidden size={16} />}
                onClick={() => navigation.selectModule("files")}
              >
                Open Files in Commands
              </Button>
            </Tabs.Panel>
          ) : null}
          {navigation.tab === "listening" ? (
            <Tabs.Panel value="listening" className={styles.panel}>
              {report ? (
                <Stack>
                  <ListeningSettings value={voice} onChange={changeVoice} />
                  <AutosaveStatus
                    state={voiceAutosave.state}
                    retry={() => voiceAutosave.controller.retry()}
                  />
                </Stack>
              ) : (
                <Text size="sm" c="dimmed">
                  Loading voice settings…
                </Text>
              )}
            </Tabs.Panel>
          ) : null}
          {navigation.tab === "speech" ? (
            <Tabs.Panel value="speech" className={styles.panel}>
              {report ? (
                <Stack>
                  <SpeechSettings value={voice} onChange={changeVoice} />
                  <AutosaveStatus
                    state={voiceAutosave.state}
                    retry={() => voiceAutosave.controller.retry()}
                  />
                </Stack>
              ) : (
                <Text size="sm" c="dimmed">
                  Loading voice settings…
                </Text>
              )}
            </Tabs.Panel>
          ) : null}
          {navigation.tab === "actions" ? (
            <Tabs.Panel
              value="actions"
              className={`${styles.panel} ${styles.commandsPanel}`}
            >
              <ActionsSettings files={<FileSettings />} />
            </Tabs.Panel>
          ) : null}
        </Tabs>
      ) : null}
    </section>
  );
}
