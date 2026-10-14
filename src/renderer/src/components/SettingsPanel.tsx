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
import { ArrowLeftIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
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
import { useAutosave } from "@/hooks/use-autosave";
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
  const [draft, setDraft] = useState(report.settings);
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState("");
  const baseline = useRef(report.settings);
  useEffect(() => {
    const changed = (event: Event): void => {
      const incoming = (event as CustomEvent<ChatSettings>).detail;
      if (!incoming) return;
      const previous = baseline.current;
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
      baseline.current = incoming;
    };
    window.addEventListener("verbo:settings-changed", changed);
    return () => window.removeEventListener("verbo:settings-changed", changed);
  }, []);
  const autosave = useAutosave<Partial<ChatSettings>>(
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

export function SettingsPage(): ReactElement {
  const navigation = useSettingsNavigation();
  const [report, setReport] = useState<SettingsRecovery | null>(null);
  const [voice, setVoice] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const [error, setError] = useState("");
  const [visited, setVisited] = useState(["model"]);
  const voiceAutosave = useAutosave<VoiceSettings>(async (value) => {
    const saved = await window.verbo.voice.setSettings(value);
    window.dispatchEvent(
      new CustomEvent(VOICE_SETTINGS_EVENT, { detail: saved }),
    );
  });
  useEffect(() => {
    void Promise.all([
      window.verbo.settings.get(),
      window.verbo.voice.settings(),
    ])
      .then(([settings, voiceSettings]) => {
        setReport(settings);
        setVoice(voiceSettings);
      })
      .catch(() => setError("Could not load Settings."));
  }, []);
  if (!visited.includes(navigation.tab))
    setVisited([...visited, navigation.tab]);
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
      <Tabs
        value={navigation.tab}
        onChange={(tab) => navigation.selectTab(tab ?? "model")}
        variant="pills"
        keepMounted
        className={styles.tabs}
        classNames={{ list: styles.tabList, tab: styles.tab }}
      >
        <Tabs.List>
          <Tabs.Tab value="model">Model</Tabs.Tab>
          <Tabs.Tab value="memory">Memory</Tabs.Tab>
          <Tabs.Tab value="files">Files</Tabs.Tab>
          <Tabs.Tab value="listening">Listening</Tabs.Tab>
          <Tabs.Tab value="speech">Speech</Tabs.Tab>
          <Tabs.Tab value="actions">Commands</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="model" className={styles.panel}>
          {report ? (
            <ModelSettings report={report} />
          ) : (
            <Text size="sm" c="dimmed">
              Loading model settings…
            </Text>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="memory" className={styles.panel}>
          <Button
            variant="default"
            onClick={() => navigation.selectModule("memory")}
          >
            Open Memory in Commands
          </Button>
        </Tabs.Panel>
        <Tabs.Panel value="files" className={styles.panel}>
          <Button
            variant="default"
            onClick={() => navigation.selectModule("files")}
          >
            Open Files in Commands
          </Button>
        </Tabs.Panel>
        <Tabs.Panel value="listening" className={styles.panel}>
          {visited.includes("listening") ? (
            <Stack>
              <ListeningSettings value={voice} onChange={changeVoice} />
              <AutosaveStatus
                state={voiceAutosave.state}
                retry={() => voiceAutosave.controller.retry()}
              />
            </Stack>
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="speech" className={styles.panel}>
          {visited.includes("speech") ? (
            <Stack>
              <SpeechSettings value={voice} onChange={changeVoice} />
              <AutosaveStatus
                state={voiceAutosave.state}
                retry={() => voiceAutosave.controller.retry()}
              />
            </Stack>
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel
          value="actions"
          className={`${styles.panel} ${styles.commandsPanel}`}
        >
          {visited.includes("actions") ? (
            <ActionsSettings files={<FileSettings />} />
          ) : null}
        </Tabs.Panel>
      </Tabs>
    </section>
  );
}
