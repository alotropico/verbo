import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import {
  webSettingsSchema,
  type SearchEngineId,
  type WebSettings,
} from "@shared/web-contracts";
import { StatusMessage } from "./StatusMessage";
import { AutosaveStatus } from "./AutosaveStatus";
import { useAutosave } from "@/hooks/use-autosave";
import type { AutosaveController } from "@/runtime/autosave";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { SettingsSection } from "./SettingsSection";
import { SettingsLabel } from "./SettingsLabel";
import styles from "./ActionsSettings.module.css";

const ENGINE_NAMES: Record<SearchEngineId, string> = {
  google: "Google",
  duckduckgo: "DuckDuckGo",
  bing: "Bing",
};

export function WebCommandSettings({
  settings,
  reload,
  register,
}: {
  settings: WebSettings;
  reload: () => void;
  register: (controller: AutosaveController<WebSettings> | null) => void;
}): ReactElement {
  const [validation, setValidation] = useState("");
  const autosave = useAutosave<WebSettings>(async (value) => {
    const result = await window.verbo.commands.saveWeb(value);
    if (!result.ok) throw new Error(result.summary);
    reload();
  });
  useEffect(() => {
    register(autosave.controller);
    return () => register(null);
  }, [register, autosave.controller]);
  const form = useForm({
    mode: "uncontrolled",
    onValuesChange: (values) => {
      const parsed = webSettingsSchema.safeParse({
        ...values,
        engineTimeoutMs: Math.round(values.engineTimeoutMs * 1000),
        searchTimeoutMs: Math.round(values.searchTimeoutMs * 1000),
        idleMs: Math.round(values.idleMs * 1000),
      });
      setValidation(
        parsed.success
          ? ""
          : (parsed.error.issues[0]?.message ?? "Check Web settings."),
      );
      if (parsed.success) autosave.controller.schedule(parsed.data);
    },
    initialValues: {
      ...settings,
      engineTimeoutMs: settings.engineTimeoutMs / 1000,
      searchTimeoutMs: settings.searchTimeoutMs / 1000,
      idleMs: settings.idleMs / 1000,
    },
  });
  const [engines, setEngines] = useState(settings.engines);
  const changeEngines = (next: SearchEngineId[]): void => {
    setEngines(next);
    form.setFieldValue("engines", next);
  };
  const reorder = (index: number, direction: -1 | 1): void => {
    const next = [...engines];
    [next[index], next[index + direction]] = [
      next[index + direction],
      next[index],
    ];
    changeEngines(next);
  };
  return (
    <SettingsSection
      title="Web search and reading"
      description="Search tries engines in this order, moving to the next when one is unavailable."
    >
      <Stack component="ol" gap="xs" m={0} p={0}>
        {engines.map((engine, index) => (
          <Group
            component="li"
            className={styles.engineRow}
            key={engine}
            justify="space-between"
            wrap="nowrap"
          >
            <Group gap="sm" wrap="nowrap">
              <Text size="xs" c="dimmed">
                {index + 1}
              </Text>
              <Text size="sm" fw={500}>
                {ENGINE_NAMES[engine]}
              </Text>
            </Group>
            <Group gap={4} wrap="nowrap">
              <ActionIcon
                variant="subtle"
                aria-label={`Move ${ENGINE_NAMES[engine]} earlier`}
                disabled={index === 0}
                onClick={() => reorder(index, -1)}
              >
                <ArrowUpIcon size={14} />
              </ActionIcon>
              <ActionIcon
                variant="subtle"
                aria-label={`Move ${ENGINE_NAMES[engine]} later`}
                disabled={index === engines.length - 1}
                onClick={() => reorder(index, 1)}
              >
                <ArrowDownIcon size={14} />
              </ActionIcon>
              <Button
                size="compact-xs"
                variant="subtle"
                disabled={engines.length === 1}
                aria-label={`Disable ${ENGINE_NAMES[engine]}`}
                onClick={() =>
                  changeEngines(engines.filter((value) => value !== engine))
                }
              >
                Disable
              </Button>
            </Group>
          </Group>
        ))}
      </Stack>
      <Group gap="xs">
        {(["google", "duckduckgo", "bing"] as const)
          .filter((engine) => !engines.includes(engine))
          .map((engine) => (
            <Button
              key={engine}
              size="compact-xs"
              variant="subtle"
              onClick={() => changeEngines([...engines, engine])}
            >
              Enable {ENGINE_NAMES[engine]}
            </Button>
          ))}
      </Group>
      <SimpleGrid type="container" cols={{ base: 1, "520px": 2 }} spacing="md">
        <Select
          label={
            <SettingsLabel
              label="Read method"
              tip="Automatic reading tries the page directly, then uses a browser if JavaScript is needed."
            />
          }
          data={[
            { value: "auto", label: "HTTP first, browser fallback" },
            { value: "http", label: "HTTP only" },
            { value: "browser", label: "Rendered browser page" },
          ]}
          key={form.key("readMethod")}
          {...form.getInputProps("readMethod")}
          allowDeselect={false}
        />
        <NumberInput
          label={
            <SettingsLabel
              label="Search results"
              tip="Maximum number of sources returned by a search, from 1 to 10."
            />
          }
          min={1}
          max={10}
          key={form.key("resultLimit")}
          {...form.getInputProps("resultLimit")}
        />
        <NumberInput
          label={
            <SettingsLabel
              label="Page text limit"
              tip="Maximum characters returned from a page. Shorter excerpts leave more room in the model's context."
            />
          }
          thousandSeparator=","
          min={500}
          max={8000}
          key={form.key("maxChars")}
          {...form.getInputProps("maxChars")}
        />
      </SimpleGrid>
      <SettingsDisclosure title="Browser and request limits">
        <TextInput
          label={
            <SettingsLabel
              label="Browser executable"
              tip="Optional path to installed Chrome or Edge. Leave blank to detect one automatically."
            />
          }
          placeholder="Auto-detect Chrome, then Edge"
          key={form.key("executable")}
          {...form.getInputProps("executable")}
        />
        <SimpleGrid
          type="container"
          cols={{ base: 1, "520px": 2 }}
          spacing="md"
        >
          <NumberInput
            label={
              <SettingsLabel
                label="Wait per search engine"
                tip="How long to wait for each engine before trying the next."
              />
            }
            suffix=" s"
            min={1}
            max={20}
            decimalScale={3}
            key={form.key("engineTimeoutMs")}
            {...form.getInputProps("engineTimeoutMs")}
          />
          <NumberInput
            label={
              <SettingsLabel
                label="Total request timeout"
                tip="Total time allowed for a search or page read, including fallback attempts."
              />
            }
            suffix=" s"
            min={1}
            max={60}
            decimalScale={3}
            key={form.key("searchTimeoutMs")}
            {...form.getInputProps("searchTimeoutMs")}
          />
          <NumberInput
            label={
              <SettingsLabel
                label="Close browser after idle"
                tip="Release the hidden browser after this long without a request."
              />
            }
            suffix=" s"
            min={10}
            max={300}
            decimalScale={3}
            key={form.key("idleMs")}
            {...form.getInputProps("idleMs")}
          />
        </SimpleGrid>
        <Switch
          label={
            <SettingsLabel
              label="Show search diagnostics"
              tip="Include an attempt summary when search engines fail or fall back."
            />
          }
          key={form.key("diagnostics")}
          {...form.getInputProps("diagnostics", { type: "checkbox" })}
        />
      </SettingsDisclosure>
      <AutosaveStatus
        state={autosave.state}
        retry={() => autosave.controller.retry()}
      />
      {validation ? (
        <StatusMessage display="plain" size="sm" tone="error">
          {validation}
        </StatusMessage>
      ) : null}
    </SettingsSection>
  );
}
