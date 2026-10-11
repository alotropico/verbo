import {
  contextChoices,
  legacyTemperatureNotice,
  sliderTemperature,
  type SettingsRecovery,
} from "@shared/settings-recovery";
import { chatSettingsSchema } from "@shared/storage-ipc";
import type { FileScopeProposal, FileScopeRecord } from "@shared/files";
import {
  ActionIcon,
  Button,
  Group,
  Modal,
  Select,
  Slider,
  Stack,
  Switch,
  Tabs,
  Text,
  Tooltip,
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
import {
  draftsFromScopes,
  filesDraftDirty,
  scopeCommitFromDrafts,
  type FileScopeDraft,
} from "./file-scope-draft";
import { MemorySettings } from "./MemorySettings";
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

function UnavailableTab({
  title,
  detail,
}: {
  title: string;
  detail: string;
}): ReactElement {
  return (
    <Stack gap="xs">
      <Text fw={500}>{title}</Text>
      <Text size="sm" c="dimmed">
        {detail}
      </Text>
    </Stack>
  );
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
  const fileEdit = useRef(false);
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

  useEffect(() => {
    const openSettings = (event: Event): void => {
      const detail = (event as CustomEvent<{ tab?: string }>).detail;
      setTab(detail?.tab ?? "memory");
      loadFiles();
      onOpen();
    };
    window.addEventListener("verbo:open-settings", openSettings);
    return () =>
      window.removeEventListener("verbo:open-settings", openSettings);
  }, [loadFiles, onOpen]);

  const scopesDirty = filesReady && filesDraftDirty(savedScopes, fileRows);

  const requestClose = (): void => {
    if (form.isDirty() || scopesDirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  return (
    <>
      <Tooltip label="Model settings">
        <ActionIcon
          variant="subtle"
          size={32}
          type="button"
          aria-label="Settings"
          onClick={() => {
            onOpen();
            loadFiles();
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
          className={styles.trigger}
        >
          <SlidersHorizontalIcon size={16} />
        </ActionIcon>
      </Tooltip>
      <Modal
        opened={opened}
        onClose={requestClose}
        title="Settings"
        centered
        trapFocus
        closeOnEscape
        returnFocus
        classNames={{ content: styles.dialog, body: styles.body }}
        size="900px"
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
            value={tab}
            onChange={(value) => setTab(value ?? "model")}
            className={styles.tabs}
            keepMounted={false}
          >
            <Tabs.List>
              <Tabs.Tab value="model">Model</Tabs.Tab>
              <Tabs.Tab value="memory">Memory</Tabs.Tab>
              <Tabs.Tab value="files">Files</Tabs.Tab>
              <Tabs.Tab value="voice">Voice</Tabs.Tab>
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
                <Select
                  label="Model"
                  description="Exact installed Ollama tag."
                  data={modelData}
                  allowDeselect={false}
                  searchable
                  nothingFoundMessage="No installed model"
                  key={form.key("model")}
                  {...form.getInputProps("model")}
                  error={
                    modelMissing
                      ? `${settings.model} is not installed.`
                      : form.errors.model
                  }
                />
                <Switch
                  label="Thinking mode"
                  description="Ask the model to include its chain-of-thought before the answer."
                  key={form.key("think")}
                  {...form.getInputProps("think", { type: "checkbox" })}
                />
                <Select
                  label="Context window"
                  description="Presets from 2K to 128K. A saved custom size stays until you change it. High values use more memory."
                  data={choices}
                  allowDeselect={false}
                  key={form.key("numCtx")}
                  {...form.getInputProps("numCtx")}
                />
                <Stack gap={4}>
                  <Text size="sm" fw={500}>
                    Temperature {temperature.toFixed(1)}
                  </Text>
                  <Slider
                    min={0}
                    max={1}
                    step={0.1}
                    label={(value) => value.toFixed(1)}
                    aria-label="Temperature"
                    key={form.key("temperature")}
                    {...form.getInputProps("temperature", { withError: false })}
                  />
                </Stack>
              </Stack>
            </Tabs.Panel>
            <Tabs.Panel value="memory" className={styles.panel}>
              <MemorySettings />
            </Tabs.Panel>
            <Tabs.Panel value="files" className={styles.panel}>
              {filesReady ? (
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
              ) : (
                <Text size="sm" c="dimmed">
                  {fileError || "Loading folders."}
                </Text>
              )}
            </Tabs.Panel>
            <Tabs.Panel value="voice" className={styles.panel}>
              <UnavailableTab
                title="Voice"
                detail="The voice service is not connected. Typed chat still works. Voice preferences will stay staged until Save once the service is available."
              />
            </Tabs.Panel>
            <Tabs.Panel value="actions" className={styles.panel}>
              <UnavailableTab
                title="Actions"
                detail="The capability catalog is not available yet. Action history will appear here when actions run."
              />
            </Tabs.Panel>
          </Tabs>
          <Group justify="space-between" className={styles.footer}>
            <Text size="xs" c="dimmed">
              Save stores model settings and folder registrations. Cancel leaves
              them unchanged.
            </Text>
            {confirmDiscard ? (
              <Group gap="xs">
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  onClick={() => setConfirmDiscard(false)}
                >
                  Keep editing
                </Button>
                <Button
                  type="button"
                  size="xs"
                  onClick={() => {
                    form.reset();
                    setFileRows(draftsFromScopes(savedScopes));
                    setFileError("");
                    setConfirmDiscard(false);
                    onClose();
                  }}
                >
                  Discard
                </Button>
              </Group>
            ) : (
              <Group gap="xs">
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  onClick={requestClose}
                >
                  Cancel
                </Button>
                <Button type="submit" size="xs" loading={form.submitting}>
                  Save
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
