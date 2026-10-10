import {
  ALTERNATE_MODEL,
  DEFAULT_MODEL,
  type ChatSettings,
} from "@shared/config";
import { chatSettingsSchema } from "@shared/storage-ipc";
import {
  ActionIcon,
  Autocomplete,
  Button,
  Group,
  Modal,
  NumberInput,
  Stack,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { CircleHelpIcon, SlidersHorizontalIcon } from "lucide-react";
import styles from "./SettingsPanel.module.css";

const FIELD_HINTS = {
  model:
    "Ollama model tag used for chat replies. Pick a suggestion or type any installed name.",
  think: "Ask the model to include its chain-of-thought before the answer.",
  temperature:
    "Sampling randomness. 0 is mostly deterministic; 2 is most random.",
  numCtx: "Token window (num_ctx) sent to Ollama. Larger uses more memory.",
} as const;

function FieldLabel({
  children,
  hint,
}: {
  children: ReactNode;
  hint: string;
}): ReactElement {
  return (
    <Group gap={6} wrap="nowrap" component="span">
      <span>{children}</span>
      <Tooltip
        label={hint}
        withArrow
        multiline
        maw={280}
        events={{ hover: true, focus: true, touch: true }}
      >
        <ActionIcon size={18} variant="subtle" aria-label={hint}>
          <CircleHelpIcon size={12} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

function SettingsForm({
  initial,
  opened,
  onOpen,
  onClose,
}: {
  initial: ChatSettings;
  opened: boolean;
  onOpen: () => void;
  onClose: () => void;
}): ReactElement {
  const form = useForm({
    mode: "uncontrolled",
    initialValues: initial,
    validate: schemaResolver(chatSettingsSchema, { sync: true }),
  });

  return (
    <>
      <Tooltip label="Model settings">
        <ActionIcon
          variant="subtle"
          size={32}
          type="button"
          aria-label="Settings"
          onClick={onOpen}
          className={styles.trigger}
        >
          <SlidersHorizontalIcon size={16} />
        </ActionIcon>
      </Tooltip>
      <Modal
        opened={opened}
        onClose={onClose}
        title="Make it your own."
        centered
        size="sm"
        overlayProps={{ backgroundOpacity: 0.35, blur: 8 }}
        closeButtonProps={{ "aria-label": "Close settings" }}
      >
        <form
          onSubmit={form.onSubmit(async (values) => {
            const next = await window.verbo.settings.set(values);
            form.setInitialValues(next);
            form.resetDirty(next);
            onClose();
          })}
        >
          <Stack gap="lg">
            <Text size="xs" c="dimmed">
              A few small adjustments. A different way of thinking.
            </Text>
            <Autocomplete
              label={<FieldLabel hint={FIELD_HINTS.model}>Model</FieldLabel>}
              data={[DEFAULT_MODEL, ALTERNATE_MODEL]}
              key={form.key("model")}
              {...form.getInputProps("model")}
            />
            <Switch
              label={
                <FieldLabel hint={FIELD_HINTS.think}>Thinking mode</FieldLabel>
              }
              key={form.key("think")}
              {...form.getInputProps("think", { type: "checkbox" })}
            />
            <NumberInput
              label={
                <FieldLabel hint={FIELD_HINTS.temperature}>
                  Temperature
                </FieldLabel>
              }
              min={0}
              max={2}
              step={0.1}
              decimalScale={1}
              key={form.key("temperature")}
              {...form.getInputProps("temperature")}
            />
            <NumberInput
              label={
                <FieldLabel hint={FIELD_HINTS.numCtx}>
                  Context window
                </FieldLabel>
              }
              min={512}
              max={131072}
              step={512}
              allowDecimal={false}
              key={form.key("numCtx")}
              {...form.getInputProps("numCtx")}
            />
            <Group justify="space-between" className={styles.footer}>
              <Text size="xs" c="dimmed">
                Applied to your next message
              </Text>
              <Button type="submit" size="xs" loading={form.submitting}>
                Save changes
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
}

export function SettingsPanel(): ReactElement | null {
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  const [opened, { open, close }] = useDisclosure(false);

  useEffect(() => {
    void window.verbo.settings.get().then(setSettings);
  }, []);

  if (!settings) return null;

  return (
    <SettingsForm
      initial={settings}
      opened={opened}
      onOpen={open}
      onClose={close}
    />
  );
}
