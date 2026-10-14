import {
  memoryInclusions,
  memoryScopes,
  memoryTextSchema,
  type MemoryChange,
  type MemoryInclusion,
  type MemoryRecord,
  type MemoryUsage,
} from "@shared/memory";
import { isPersistedThreadId } from "@shared/thread-identity";
import { chatPlaceholderTitle } from "@shared/thread-title";
import { estimateTokens } from "@shared/token-estimate";
import { Button, Text, Textarea } from "@mantine/core";
import { ChoiceInput } from "./ChoiceInput";
import { schemaResolver, useForm } from "@mantine/form";
import { useAuiState } from "@assistant-ui/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { z } from "zod";
import { SettingsLabel } from "./SettingsLabel";
import { StatusMessage } from "./StatusMessage";
import { SettingsSection } from "./SettingsSection";
import { useAutosave } from "@/hooks/use-autosave";
import { AutosaveStatus } from "./AutosaveStatus";
import { useConfirmation } from "./confirmation-context";
import styles from "./MemorySettings.module.css";

type Browser = {
  entries: MemoryRecord[];
  usage: MemoryUsage;
  changes: MemoryChange[];
};

const addSchema = z.object({
  text: memoryTextSchema,
  scope: z.enum(memoryScopes),
  inclusion: z.enum(memoryInclusions),
});

function MemoryRow({
  entry,
  onChanged,
}: {
  entry: MemoryRecord;
  onChanged: () => void;
}): ReactElement {
  const [text, setText] = useState(entry.text);
  const [error, setError] = useState("");
  const [inclusion, setInclusion] = useState(entry.inclusion);
  const current = useRef(text);
  const baseline = useRef(entry.text);
  const confirm = useConfirmation();
  const autosave = useAutosave<{
    id: string;
    text?: string;
    inclusion?: MemoryInclusion;
  }>(
    async (value) => {
      const result = await window.verbo.memory.update(value);
      if (!result.ok) throw new Error(result.summary);
      if (value.text !== undefined) baseline.current = value.text;
      window.dispatchEvent(new Event("verbo:memory-changed"));
      onChanged();
    },
    (previous, next) => ({ ...previous, ...next }),
  );
  useEffect(() => {
    if (current.current === baseline.current) {
      current.current = entry.text;
      setText(entry.text);
      baseline.current = entry.text;
      setInclusion(entry.inclusion);
    }
  }, [entry.text, entry.inclusion]);

  return (
    <li className={styles.entry}>
      <Textarea
        label={
          <SettingsLabel
            label="Memory text"
            tip="The saved note. Valid edits save automatically; leaving the field saves immediately."
          />
        }
        autosize
        minRows={2}
        value={text}
        onChange={(event) => {
          const next = event.currentTarget.value;
          current.current = next;
          setText(next);
          const parsed = memoryTextSchema.safeParse(next);
          setError(
            parsed.success
              ? ""
              : (parsed.error.issues[0]?.message ?? "Check the memory text."),
          );
          if (parsed.success)
            autosave.controller.schedule({ id: entry.id, text: parsed.data });
        }}
        onBlur={() => void autosave.controller.flush()}
      />
      <Text size="xs" c="dimmed">
        Estimated tokens: {estimateTokens(text.trim())}
      </Text>
      <div className={styles.entryActions}>
        <ChoiceInput
          label={
            <SettingsLabel
              label="When to use"
              tip="Always includes the note in every message. On demand keeps it out until it is retrieved."
            />
          }
          className={styles.inclusion}
          data={[
            { value: "always", label: "Always" },
            { value: "on_demand", label: "On demand" },
          ]}
          value={inclusion}
          allowDeselect={false}
          onChange={(value) => {
            if (value === "always" || value === "on_demand") {
              setInclusion(value);
              autosave.controller.schedule({ id: entry.id, inclusion: value });
            }
          }}
        />
        <Button
          type="button"
          size="xs"
          variant="subtle"
          color="red"
          onClick={() =>
            void confirm({
              title: "Remove memory?",
              message: "Remove this saved note?",
              confirmLabel: "Remove memory",
              destructive: true,
              onConfirm: async () => {
                await autosave.controller.reset();
                const result = await window.verbo.memory.remove(entry.id);
                if (!result.ok) throw new Error(result.summary);
                window.dispatchEvent(new Event("verbo:memory-changed"));
                onChanged();
              },
            })
          }
        >
          Remove
        </Button>
      </div>
      <AutosaveStatus
        state={autosave.state}
        retry={() => autosave.controller.retry()}
      />
      {error ? (
        <StatusMessage display="plain" size="sm" tone="error">
          {error}
        </StatusMessage>
      ) : null}
    </li>
  );
}

export function MemorySettings(): ReactElement {
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const chatName = useAuiState(
    (state) =>
      state.threads.threadItems.find(
        (item) => item.id === state.threads.mainThreadId,
      )?.title || chatPlaceholderTitle(state.threads.mainThreadId),
  );
  const thisChat = `This chat (${chatName})`;
  const persisted = isPersistedThreadId(threadId) ? threadId : undefined;
  const [browser, setBrowser] = useState<Browser | null>(null);
  const [error, setError] = useState("");
  const form = useForm({
    mode: "uncontrolled",
    initialValues: {
      text: "",
      scope: "global" as "global" | "thread",
      inclusion: "on_demand" as MemoryInclusion,
    },
    validate: schemaResolver(addSchema, { sync: true }),
  });
  const memoryText = form.useWatchValue("text");

  const load = useCallback((): void => {
    void window.verbo.memory.list().then((next) => {
      setBrowser(next);
    });
  }, []);

  useEffect(() => {
    load();
    window.addEventListener("verbo:memory-changed", load);
    return () => window.removeEventListener("verbo:memory-changed", load);
  }, [load]);

  const globalEntries =
    browser?.entries.filter((entry) => entry.scope === "global") ?? [];
  const threadEntries =
    browser?.entries.filter(
      (entry) => entry.scope === "thread" && entry.threadId === persisted,
    ) ?? [];

  return (
    <SettingsSection
      title="Memory"
      description="Keep notes for future conversations. Valid edits save automatically."
    >
      <div className={styles.addForm}>
        <Textarea
          label={
            <SettingsLabel
              label="New memory"
              tip="A note the model can use in later messages."
            />
          }
          autosize
          minRows={2}
          key={form.key("text")}
          {...form.getInputProps("text")}
        />
        <Text size="xs" c="dimmed">
          Estimated tokens: {estimateTokens(memoryText.trim())}
        </Text>
        <div className={styles.addActions}>
          <ChoiceInput
            className={styles.addField}
            label={
              <SettingsLabel
                label="Scope"
                tip={`All chats keeps the note everywhere. ${thisChat} keeps it in the open conversation.`}
              />
            }
            allowDeselect={false}
            data={[
              { value: "global", label: "All chats" },
              {
                value: "thread",
                label: thisChat,
                disabled: !persisted,
              },
            ]}
            key={form.key("scope")}
            {...form.getInputProps("scope")}
          />
          <ChoiceInput
            className={styles.addField}
            label={
              <SettingsLabel
                label="When to use"
                tip="Always includes the note in every message. On demand keeps it out until it is retrieved."
              />
            }
            allowDeselect={false}
            data={[
              { value: "on_demand", label: "On demand" },
              { value: "always", label: "Always" },
            ]}
            key={form.key("inclusion")}
            {...form.getInputProps("inclusion")}
          />
          <Button
            type="button"
            size="xs"
            onClick={() => {
              void form.onSubmit(async (values) => {
                setError("");
                if (values.scope === "thread" && !persisted) {
                  setError("Open a chat before saving a thread note.");
                  return;
                }
                const result = await window.verbo.memory.add({
                  text: values.text,
                  scope: values.scope,
                  inclusion: values.inclusion,
                  ...(values.scope === "thread" && persisted
                    ? { threadId: persisted }
                    : {}),
                });
                if (!result.ok) {
                  setError(result.summary);
                  return;
                }
                form.setFieldValue("text", "");
                window.dispatchEvent(new Event("verbo:memory-changed"));
                load();
              })();
            }}
          >
            Add memory
          </Button>
        </div>
      </div>
      {error ? (
        <StatusMessage display="plain" size="sm" tone="error">
          {error}
        </StatusMessage>
      ) : null}
      <section>
        <Text fw={500} size="sm">
          All chats
        </Text>
        {globalEntries.length === 0 ? (
          <Text size="sm" c="dimmed">
            No memories shared across chats.
          </Text>
        ) : (
          <ul className={styles.list}>
            {globalEntries.map((entry) => (
              <MemoryRow key={entry.id} entry={entry} onChanged={load} />
            ))}
          </ul>
        )}
      </section>
      <section>
        <Text fw={500} size="sm">
          {thisChat}
        </Text>
        {threadEntries.length === 0 ? (
          <Text size="sm" c="dimmed">
            No memories for {thisChat}.
          </Text>
        ) : (
          <ul className={styles.list}>
            {threadEntries.map((entry) => (
              <MemoryRow key={entry.id} entry={entry} onChanged={load} />
            ))}
          </ul>
        )}
      </section>
      <section>
        <Text fw={500} size="sm">
          Recent changes
        </Text>
        {(browser?.changes.length ?? 0) === 0 ? (
          <Text size="sm" c="dimmed">
            No memory changes yet.
          </Text>
        ) : (
          <ul className={styles.changes}>
            {browser?.changes.map((change) => (
              <li key={change.id}>{change.summary}</li>
            ))}
          </ul>
        )}
      </section>
    </SettingsSection>
  );
}
