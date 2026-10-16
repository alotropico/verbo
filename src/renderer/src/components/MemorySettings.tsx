import { BookmarkPlusIcon, Trash2Icon } from "lucide-react";
import {
  memoryInclusions,
  memoryScopes,
  memoryTextSchema,
  contextAudiencesSchema,
  type MemoryChange,
  type MemoryInclusion,
  type MemoryRecord,
  type MemoryUsage,
} from "@shared/memory";
import { isPersistedThreadId } from "@shared/thread-identity";
import { chatPlaceholderTitle } from "@shared/thread-title";
import { estimateTokens } from "@shared/token-estimate";
import { Button, MultiSelect, Text, Textarea } from "@mantine/core";
import type { AgentId } from "@shared/workflows";
import { ContextMeters } from "./ContextMeters";
import { ChoiceInput } from "./ChoiceInput";
import { schemaResolver } from "@mantine/form";
import { useAuiState } from "@assistant-ui/react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  type ReactElement,
} from "react";
import { z } from "zod";
import { SettingsLabel } from "./SettingsLabel";
import { StatusMessage } from "./StatusMessage";
import { SettingsSection } from "./SettingsSection";
import {
  useSettingsAutosave,
  useSettingsDraft,
  useSettingsRef,
  useSettingsForm,
} from "@/hooks/use-settings-draft";
import { AutosaveStatus } from "./AutosaveStatus";
import { useConfirmation } from "./confirmation-context";
import styles from "./MemorySettings.module.css";

type Browser = {
  entries: MemoryRecord[];
  more: boolean;
  usage: MemoryUsage;
  changes: MemoryChange[];
};

const addSchema = z.object({
  text: memoryTextSchema,
  scope: z.enum(memoryScopes),
  inclusion: z.enum(memoryInclusions),
  audiences: contextAudiencesSchema,
});
const recipients = [
  { value: "conversational", label: "Conversational" },
  { value: "decision", label: "Decision" },
  { value: "writer", label: "Writer" },
  { value: "commander", label: "Commander" },
];

function MemoryRow({
  entry,
  onChanged,
}: {
  entry: MemoryRecord;
  onChanged: () => void;
}): ReactElement {
  const key = `memory-row/${entry.id}/`;
  const [text, setText] = useSettingsDraft(key + "text", entry.text);
  const [error, setError] = useSettingsDraft(key + "error", "");
  const [inclusion, setInclusion] = useSettingsDraft(
    key + "inclusion",
    entry.inclusion,
  );
  const [audiences, setAudiences] = useSettingsDraft<AgentId[]>(
    key + "audiences",
    entry.audiences,
  );
  const currentRef = useSettingsRef(key + "current", text);
  const baselineRef = useSettingsRef(key + "baseline", entry.text);
  const confirm = useConfirmation();
  const autosave = useSettingsAutosave<{
    id: string;
    text?: string;
    inclusion?: MemoryInclusion;
    audiences?: AgentId[];
  }>(
    key + "save",
    async (value) => {
      const result = await window.verbo.memory.update(value);
      if (!result.ok) throw new Error(result.summary);
      if (value.text !== undefined) baselineRef.current = value.text;
      window.dispatchEvent(new Event("verbo:memory-changed"));
      onChanged();
    },
    (previous, next) => ({ ...previous, ...next }),
  );
  const synchronize = useEffectEvent(() => {
    if (autosave.state.status === "saving" || autosave.state.status === "error")
      return;
    if (currentRef.current === baselineRef.current) {
      currentRef.current = entry.text;
      setText(entry.text);
      baselineRef.current = entry.text;
      setInclusion(entry.inclusion);
      setAudiences(entry.audiences);
    }
  });
  useEffect(() => {
    synchronize();
  }, [entry.text, entry.inclusion, entry.audiences]);

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
          currentRef.current = next;
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
      <MultiSelect
        label="Recipients"
        description={
          audiences.length
            ? "Only these agents can receive this note."
            : "Unassigned: this note is preserved and is not injected into any agent."
        }
        data={recipients}
        value={audiences}
        onChange={(values) => {
          const next = contextAudiencesSchema.parse(values);
          setAudiences(next);
          autosave.controller.schedule({ id: entry.id, audiences: next });
        }}
        onBlur={() => void autosave.controller.flush()}
      />
      <div className={styles.entryActions}>
        <ChoiceInput
          label={
            <SettingsLabel
              label="When to use"
              tip="Always includes the note for its selected recipients. On demand keeps it out until an assigned agent retrieves it."
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
          leftSection={<Trash2Icon aria-hidden size={16} />}
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
  const [error, setError] = useSettingsDraft("memory/error", "");
  const [groupAudiences, setGroupAudiences] = useState<AgentId[]>([
    "conversational",
  ]);
  const [assigning, setAssigning] = useState(false);
  const [page, setPage] = useState(0);
  const [meterAudience, setMeterAudience] = useState<AgentId>("conversational");
  const form = useSettingsForm("memory/form", {
    mode: "uncontrolled",
    initialValues: {
      text: "",
      scope: "global" as "global" | "thread",
      inclusion: "on_demand" as MemoryInclusion,
      audiences: ["conversational"] as AgentId[],
    },
    validate: schemaResolver(addSchema, { sync: true }),
  });
  const memoryText = form.useWatchValue("text");

  const load = useCallback((): void => {
    void window.verbo.memory
      .list({ offset: page * 100 })
      .then((next) => {
        setBrowser(next);
      })
      .catch(() => setError("Notes could not be loaded. Try again."));
  }, [page, setBrowser, setError]);

  useEffect(() => {
    load();
    window.addEventListener("verbo:memory-changed", load);
    return () => window.removeEventListener("verbo:memory-changed", load);
  }, [load]);

  const globalEntries =
    browser?.entries.filter(
      (entry) => entry.scope === "global" && entry.audiences.length,
    ) ?? [];
  const threadEntries =
    browser?.entries.filter(
      (entry) =>
        entry.scope === "thread" &&
        entry.threadId === persisted &&
        entry.audiences.length,
    ) ?? [];
  const unassigned =
    browser?.entries.filter((entry) => !entry.audiences.length) ?? [];

  return (
    <SettingsSection
      title="Memory"
      description="Keep notes for future conversations. Valid edits save automatically."
    >
      {unassigned.length > 0 ? (
        <section>
          <Text fw={500} size="sm">
            Unassigned notes ({unassigned.length})
          </Text>
          <Text size="sm">
            These preserved notes are not sent to any agent. Edit each note or
            assign the group below.
          </Text>
          <MultiSelect
            label="Group recipients"
            data={recipients}
            value={groupAudiences}
            onChange={(values) =>
              setGroupAudiences(contextAudiencesSchema.parse(values))
            }
          />
          <Button
            size="xs"
            variant="subtle"
            loading={assigning}
            disabled={!groupAudiences.length}
            onClick={() => {
              setAssigning(true);
              setError("");
              void Promise.all(
                unassigned.map((entry) =>
                  window.verbo.memory.update({
                    id: entry.id,
                    audiences: groupAudiences,
                  }),
                ),
              )
                .then((results) => {
                  const failed = results.find((result) => !result.ok);
                  if (failed) setError(failed.summary);
                  window.dispatchEvent(new Event("verbo:memory-changed"));
                  load();
                })
                .catch(() =>
                  setError(
                    "Recipient assignment could not be saved. Completed assignments are retained.",
                  ),
                )
                .finally(() => setAssigning(false));
            }}
          >
            Assign displayed unassigned notes
          </Button>
          <ul className={styles.list}>
            {unassigned.map((entry) => (
              <MemoryRow key={entry.id} entry={entry} onChanged={load} />
            ))}
          </ul>
        </section>
      ) : null}
      <div>
        <Button
          size="xs"
          variant="subtle"
          disabled={page === 0}
          onClick={() => setPage((value) => value - 1)}
        >
          Previous notes
        </Button>
        <Text size="xs" component="span">
          Page {page + 1}
        </Text>
        <Button
          size="xs"
          variant="subtle"
          disabled={!browser?.more}
          onClick={() => setPage((value) => value + 1)}
        >
          Next notes
        </Button>
      </div>
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
        <MultiSelect
          label="Recipients for new note"
          data={recipients}
          key={form.key("audiences")}
          {...form.getInputProps("audiences")}
        />
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
            leftSection={<BookmarkPlusIcon aria-hidden size={16} />}
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
                  audiences: values.audiences,
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
      <ChoiceInput
        label="Context meter audience"
        data={recipients}
        value={meterAudience}
        allowDeselect={false}
        onChange={(value) => {
          const parsed = contextAudiencesSchema.safeParse([value]);
          if (parsed.success) setMeterAudience(parsed.data[0]!);
        }}
      />
      <ContextMeters audience={meterAudience} />
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
