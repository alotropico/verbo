import {
  contextChoices,
  legacyTemperatureNotice,
  sliderTemperature,
  type SettingsRecovery,
} from "@shared/settings-recovery";
import { chatSettingsSchema } from "@shared/storage-ipc";
import {
  DEFAULT_VOICE_SETTINGS,
  sameVoiceSettings,
  VOICE_SETTINGS_EVENT,
  type VoiceSettings,
} from "@shared/voice-settings";
import type { FileScopeProposal, FileScopeRecord } from "@shared/files";
import {
  Button,
  Group,
  Modal,
  Stack,
  Switch,
  Tabs,
  Text,
} from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { SlidersHorizontalIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { z } from "zod";
import { FileSettings } from "./FileSettings";
import { ActionsSettings } from "./ActionsSettings";
import {
  draftsFromScopes,
  filesDraftDirty,
  scopeCommitFromDrafts,
  type FileScopeDraft,
} from "./file-scope-draft";
import { MemorySettings } from "./MemorySettings";
import { FileQueryPanel } from "./FileQueryPanel";
import { ListeningSettings, SpeechSettings } from "./VoiceSettings";
import { SettingsSlider } from "./SettingsSlider";
import { ChoiceInput } from "./ChoiceInput";
import { SettingsLabel } from "./SettingsLabel";
import styles from "./SettingsPanel.module.css";

type ModelFormValues = {
  model: string;
  think: boolean;
  temperature: number;
  numCtx: string;
  keepAlive: string;
};

type InstalledModels =
  | { ok: true; models: string[] }
  | { ok: false; error: string; models?: string[] };

function modelFormSchema(contextValues: string[]): z.ZodType<ModelFormValues> {
  return z.object({
    model: z.string().min(1).max(128),
    think: z.boolean(),
    temperature: z.number().min(0).max(1),
    numCtx: z
      .string()
      .refine(
        (value) => contextValues.includes(value),
        "Choose a context size.",
      ),
    keepAlive: z.string().min(1).max(32),
  });
}

function SettingsForm({
  report,
  opened,
  onOpen,
  onClose,
  onSaved,
}: {
  report: SettingsRecovery;
  opened: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSaved: (report: SettingsRecovery) => void;
}): ReactElement {
  const { settings } = report;
  const choices = contextChoices(settings.numCtx);
  const [models, setModels] = useState<InstalledModels | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [tab, setTab] = useState("model");
  const [savedScopes, setSavedScopes] = useState<FileScopeRecord[]>([]);
  const [fileRows, setFileRows] = useState<FileScopeDraft[]>([]);
  const [proposal, setProposal] = useState<FileScopeProposal | null>(null);
  const [fileError, setFileError] = useState("");
  const [filesReady, setFilesReady] = useState(false);
  const [savedVoice, setSavedVoice] = useState<VoiceSettings>(
    DEFAULT_VOICE_SETTINGS,
  );
  const [voiceDraft, setVoiceDraft] = useState<VoiceSettings>(
    DEFAULT_VOICE_SETTINGS,
  );
  const [voiceReady, setVoiceReady] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const fileEdit = useRef(false);
  const voiceEdit = useRef(false);
  const form = useForm<ModelFormValues>({
    mode: "uncontrolled",
    initialValues: {
      model: settings.model,
      think: settings.think,
      temperature: sliderTemperature(settings.temperature),
      numCtx: String(settings.numCtx),
      keepAlive: settings.keepAlive,
    },
    validate: schemaResolver(
      modelFormSchema(choices.map((choice) => choice.value)),
      { sync: true },
    ),
  });
  const temperature = form.useWatchValue("temperature");
  const temperatureNotice = legacyTemperatureNotice(settings.temperature);
  const modelMissing =
    models?.ok === true && !models.models.includes(settings.model);
  const modelData = [
    ...(models?.ok ? models.models : [settings.model]),
    ...(modelMissing ? [settings.model] : []),
  ]
    .filter((model, index, all) => all.indexOf(model) === index)
    .map((model) => ({
      value: model,
      label:
        modelMissing && model === settings.model
          ? `${model} (not installed)`
          : model,
    }));

  const loadFiles = useCallback((): void => {
    fileEdit.current = false;
    void window.verbo.files
      .list()
      .then((result) => {
        if (fileEdit.current) return;
        setSavedScopes(result.scopes);
        setFileRows(draftsFromScopes(result.scopes));
        setProposal(result.proposal);
        setFileError("");
        setFilesReady(true);
      })
      .catch((caught: unknown) => {
        setFileError(
          caught instanceof Error ? caught.message : "Could not load folders.",
        );
      });
  }, [setFileError, setFileRows, setFilesReady, setProposal, setSavedScopes]);

  const loadVoice = useCallback((): void => {
    voiceEdit.current = false;
    void window.verbo.voice
      .settings()
      .then((next) => {
        setSavedVoice(next);
        if (!voiceEdit.current) setVoiceDraft(next);
        setVoiceReady(true);
      })
      .catch(() => {
        setVoiceReady(true);
      });
  }, [setSavedVoice, setVoiceDraft, setVoiceReady]);

  useEffect(() => {
    const openSettings = (event: Event): void => {
      const detail = (event as CustomEvent<{ tab?: string }>).detail;
      const requested = detail?.tab ?? "memory";
      setTab(requested === "voice" ? "listening" : requested);
      loadFiles();
      loadVoice();
      onOpen();
    };
    window.addEventListener("verbo:open-settings", openSettings);
    return () =>
      window.removeEventListener("verbo:open-settings", openSettings);
  }, [loadFiles, loadVoice, onOpen]);

  const scopesDirty = filesReady && filesDraftDirty(savedScopes, fileRows);
  const voiceDirty = voiceReady && !sameVoiceSettings(savedVoice, voiceDraft);
  const saveNote =
    tab === "memory"
      ? "Memory changes are saved immediately and apply to the next message."
      : tab === "actions"
        ? "Project and AGS changes are saved immediately."
        : "Model, folder, and voice changes take effect when you save.";

  const requestClose = (): void => {
    if (form.isDirty() || scopesDirty || voiceDirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  return (
    <>
      <hr className={styles.divider} />
      <Button
        type="button"
        variant="default"
        radius="xl"
        fullWidth
        justify="flex-start"
        aria-label="Settings"
        className={styles.trigger}
        onClick={() => {
          onOpen();
          loadFiles();
          loadVoice();
          void window.verbo.ollama.status().then((status) => {
            if (status.ok) setModels({ ok: true, models: status.models });
            else
              setModels({
                ok: false,
                error: status.error,
                models: status.models,
              });
          });
        }}
      >
        <SlidersHorizontalIcon className={styles.triggerIcon} size={16} />
        Settings
      </Button>
      <Modal
        opened={opened}
        onClose={requestClose}
        title="Settings"
        centered
        trapFocus
        closeOnEscape
        returnFocus
        classNames={{
          content: styles.dialog,
          header: styles.header,
          body: styles.body,
        }}
        size="900px"
        xOffset={16}
        yOffset={16}
        overlayProps={{ backgroundOpacity: 0.35, blur: 8 }}
        closeButtonProps={{ "aria-label": "Close settings" }}
      >
        <form
          className={styles.form}
          onSubmit={form.onSubmit(async (values) => {
            if (scopesDirty) {
              const committed = await window.verbo.files.commit(
                scopeCommitFromDrafts(fileRows),
              );
              if (!committed.ok) {
                setFileError(committed.summary);
                setTab("files");
                return;
              }
              setSavedScopes(committed.scopes);
              setFileRows(draftsFromScopes(committed.scopes));
              setFileError("");
            }
            if (voiceDirty) {
              try {
                const nextVoice =
                  await window.verbo.voice.setSettings(voiceDraft);
                setSavedVoice(nextVoice);
                setVoiceDraft(nextVoice);
                window.dispatchEvent(
                  new CustomEvent(VOICE_SETTINGS_EVENT, { detail: nextVoice }),
                );
              } catch (caught: unknown) {
                setVoiceError(
                  caught instanceof Error
                    ? caught.message
                    : "Could not save voice settings.",
                );
                setTab("listening");
                return;
              }
              setVoiceError("");
            }
            const saved = chatSettingsSchema.parse({
              ...values,
              numCtx: Number(values.numCtx),
            });
            const next = await window.verbo.settings.set(saved);
            const snapshot = { settings: next, issues: [] };
            form.setInitialValues({
              model: next.model,
              think: next.think,
              temperature: sliderTemperature(next.temperature),
              numCtx: String(next.numCtx),
              keepAlive: next.keepAlive,
            });
            form.resetDirty();
            onSaved(snapshot);
            onClose();
          })}
        >
          <Tabs
            variant="pills"
            value={tab}
            onChange={(value) => setTab(value ?? "model")}
            className={styles.tabs}
            classNames={{ list: styles.tabList, tab: styles.tab }}
            keepMounted={false}
          >
            <Tabs.List>
              <Tabs.Tab value="model">Model</Tabs.Tab>
              <Tabs.Tab value="memory">Memory</Tabs.Tab>
              <Tabs.Tab value="files">Files</Tabs.Tab>
              <Tabs.Tab value="listening">Listening</Tabs.Tab>
              <Tabs.Tab value="speech">Speech</Tabs.Tab>
              <Tabs.Tab value="actions">Actions</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="model" className={styles.panel}>
              <Stack gap="md">
                {report.issues.map((issue) => (
                  <Text key={issue} className={styles.notice} size="sm">
                    {issue}
                  </Text>
                ))}
                {temperatureNotice ? (
                  <Text className={styles.notice} size="sm">
                    {temperatureNotice}
                  </Text>
                ) : null}
                {models?.ok === false ? (
                  <Text className={styles.notice} size="sm">
                    Could not list installed models. {models.error}
                  </Text>
                ) : null}
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
                  key={form.key("model")}
                  {...form.getInputProps("model")}
                  error={
                    modelMissing
                      ? `${settings.model} is not installed.`
                      : form.errors.model
                  }
                />
                <Switch
                  label={
                    <SettingsLabel
                      label="Thinking mode"
                      tip="Let supported models reason before answering."
                    />
                  }
                  key={form.key("think")}
                  {...form.getInputProps("think", { type: "checkbox" })}
                />
                <ChoiceInput
                  label={
                    <SettingsLabel
                      label="Context window"
                      tip="How much conversation the model can use at once. Larger windows use more memory."
                    />
                  }
                  data={choices}
                  allowDeselect={false}
                  key={form.key("numCtx")}
                  {...form.getInputProps("numCtx")}
                />
                <SettingsSlider
                  label="Temperature"
                  description="Lower values give more consistent answers. Higher values add variety."
                  display={temperature.toFixed(1)}
                  min={0}
                  max={1}
                  step={0.1}
                  key={form.key("temperature")}
                  {...form.getInputProps("temperature", { withError: false })}
                />
              </Stack>
            </Tabs.Panel>
            <Tabs.Panel value="memory" className={styles.panel}>
              <MemorySettings />
            </Tabs.Panel>
            <Tabs.Panel value="files" className={styles.panel}>
              {filesReady ? (
                <Stack gap="md">
                  <FileSettings
                    proposal={proposal}
                    rows={fileRows}
                    error={fileError}
                    onChange={(rows) => {
                      fileEdit.current = true;
                      setFileRows(rows);
                    }}
                    onError={setFileError}
                  />
                  <FileQueryPanel />
                </Stack>
              ) : (
                <Text size="sm" c="dimmed">
                  {fileError || "Loading folders."}
                </Text>
              )}
            </Tabs.Panel>
            <Tabs.Panel value="listening" className={styles.panel}>
              {voiceError ? (
                <Text className={styles.notice} size="sm">
                  {voiceError}
                </Text>
              ) : null}
              <ListeningSettings
                value={voiceDraft}
                onChange={(next) => {
                  voiceEdit.current = true;
                  setVoiceDraft(next);
                }}
              />
            </Tabs.Panel>
            <Tabs.Panel value="speech" className={styles.panel}>
              <SpeechSettings
                value={voiceDraft}
                onChange={(next) => {
                  voiceEdit.current = true;
                  setVoiceDraft(next);
                }}
              />
            </Tabs.Panel>
            <Tabs.Panel value="actions" className={styles.panel}>
              <ActionsSettings />
            </Tabs.Panel>
          </Tabs>
          <Group justify="space-between" className={styles.footer}>
            <Text size="xs" c="dimmed" className={styles.footerNote}>
              {confirmDiscard
                ? "Discard unsaved model, folder, and voice changes?"
                : saveNote}
            </Text>
            {confirmDiscard ? (
              <Group gap="xs" className={styles.footerActions}>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  onClick={() => setConfirmDiscard(false)}
                >
                  Keep editing
                </Button>
                <Button
                  type="button"
                  size="sm"
                  color="red"
                  variant="light"
                  onClick={() => {
                    form.reset();
                    setFileRows(draftsFromScopes(savedScopes));
                    setVoiceDraft(savedVoice);
                    voiceEdit.current = false;
                    setVoiceError("");
                    setFileError("");
                    setConfirmDiscard(false);
                    onClose();
                  }}
                >
                  Discard changes
                </Button>
              </Group>
            ) : (
              <Group gap="xs" className={styles.footerActions}>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  onClick={requestClose}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" loading={form.submitting}>
                  Save changes
                </Button>
              </Group>
            )}
          </Group>
        </form>
      </Modal>
    </>
  );
}

export function SettingsPanel(): ReactElement | null {
  const [report, setReport] = useState<SettingsRecovery | null>(null);
  const [opened, { open, close }] = useDisclosure(false);

  useEffect(() => {
    void window.verbo.settings.get().then(setReport);
  }, []);

  if (!report) return null;

  return (
    <SettingsForm
      report={report}
      opened={opened}
      onOpen={open}
      onClose={close}
      onSaved={setReport}
    />
  );
}
