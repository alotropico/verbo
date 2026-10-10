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
import { Button, Select, Stack, Text, Textarea } from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { useAuiState } from "@assistant-ui/react";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { z } from "zod";
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

  const save = (inclusion: MemoryInclusion, nextText = text): void => {
    if (nextText === entry.text && inclusion === entry.inclusion) return;
    setError("");
    void window.verbo.memory
      .update({
        id: entry.id,
        ...(nextText !== entry.text ? { text: nextText } : {}),
        ...(inclusion !== entry.inclusion ? { inclusion } : {}),
      })
      .then((result) => {
        if (!result.ok) {
          setError(result.summary);
          return;
        }
        window.dispatchEvent(new Event("verbo:memory-changed"));
        onChanged();
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error ? caught.message : "Could not update memory.",
        );
      });
  };

  return (
    <li className={styles.entry}>
      <Textarea
        aria-label="Memory text"
        autosize
        minRows={2}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <div className={styles.entryActions}>
        <Select
          aria-label="Inclusion"
          data={[
            { value: "always", label: "Always" },
            { value: "on_demand", label: "On demand" },
          ]}
          value={entry.inclusion}
          allowDeselect={false}
          onChange={(value) => {
            if (value === "always" || value === "on_demand") save(value);
          }}
        />
        <Button
          type="button"
          size="xs"
          variant="default"
          onClick={() => save(entry.inclusion)}
        >
          Save text
        </Button>
        <Button
          type="button"
          size="xs"
          variant="subtle"
          color="red"
          onClick={() => {
            void window.verbo.memory.remove(entry.id).then((result) => {
              if (!result.ok) {
                setError(result.summary);
                return;
              }
              window.dispatchEvent(new Event("verbo:memory-changed"));
              onChanged();
            });
          }}
        >
          Remove
        </Button>
      </div>
      {error ? (
        <Text className={styles.error} size="sm">
          {error}
        </Text>
      ) : null}
    </li>
  );
}

export function MemorySettings(): ReactElement {
  const threadId = useAuiState((state) => state.threads.mainThreadId);
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

  const load = useCallback((): void => {
    void window.verbo.memory.list().then((next) => {
      setBrowser(next);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const usage = browser?.usage;
  const percent =
    usage && usage.budget > 0
      ? Math.round((usage.tokens / usage.budget) * 100)
      : 0;
  const globalEntries =
    browser?.entries.filter((entry) => entry.scope === "global") ?? [];
  const threadEntries =
    browser?.entries.filter(
      (entry) => entry.scope === "thread" && entry.threadId === persisted,
    ) ?? [];

  return (
    <Stack gap="md">
      <Text size="sm">
        Always-on memory {usage?.tokens ?? 0} / {usage?.budget ?? 512} estimated
        tokens ({percent}%). A change applies on the next turn. Cancel does not
        undo a memory action that already completed.
      </Text>
      <div className={styles.addForm}>
        <Textarea
          label="New memory"
          autosize
          minRows={2}
          key={form.key("text")}
          {...form.getInputProps("text")}
        />
        <div className={styles.addActions}>
          <Select
            label="Scope"
            allowDeselect={false}
            data={[
              { value: "global", label: "Global" },
              {
                value: "thread",
                label: "This thread",
                disabled: !persisted,
              },
            ]}
            key={form.key("scope")}
            {...form.getInputProps("scope")}
          />
          <Select
            label="Inclusion"
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
            Add
          </Button>
        </div>
      </div>
      {error ? (
        <Text className={styles.error} size="sm">
          {error}
        </Text>
      ) : null}
      <section>
        <Text fw={500} size="sm">
          Global
        </Text>
        {globalEntries.length === 0 ? (
          <Text size="sm" c="dimmed">
            No global memories.
          </Text>
        ) : (
          <ul className={styles.list}>
            {globalEntries.map((entry) => (
              <MemoryRow
                key={`${entry.id}:${entry.updatedAt}`}
                entry={entry}
                onChanged={load}
              />
            ))}
          </ul>
        )}
      </section>
      <section>
        <Text fw={500} size="sm">
          This thread
        </Text>
        {threadEntries.length === 0 ? (
          <Text size="sm" c="dimmed">
            No thread notes.
          </Text>
        ) : (
          <ul className={styles.list}>
            {threadEntries.map((entry) => (
              <MemoryRow
                key={`${entry.id}:${entry.updatedAt}`}
                entry={entry}
                onChanged={load}
              />
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
    </Stack>
  );
}
