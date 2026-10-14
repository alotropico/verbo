import {
  ActionIcon,
  Code,
  Group,
  Modal,
  Stack,
  Table,
  TagsInput,
  Text,
  Tooltip,
} from "@mantine/core";
import { CopyIcon, InfoIcon, RotateCcwIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  commandAliasesSchema,
  type CommandNode,
  type CommandSettings,
} from "@shared/commands";
import { useAutosave } from "@/hooks/use-autosave";
import type { AutosaveController } from "@/runtime/autosave";
import { AutosaveStatus } from "./AutosaveStatus";
import { useConfirmation } from "./confirmation-context";

function AliasRow({
  node,
  register,
  restore,
  details,
  reload,
}: {
  node: CommandNode;
  register: (
    id: string,
    controller: AutosaveController<string[]> | null,
  ) => void;
  restore: (node: CommandNode) => void;
  details: (id: string) => void;
  reload: () => void;
}): ReactElement {
  const [aliases, setAliases] = useState(node.aliases);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const current = useRef(aliases);
  const baseline = useRef(JSON.stringify(node.aliases));
  const autosave = useAutosave<string[]>(async (value) => {
    const result = await window.verbo.commands.save({
      nodeId: node.id,
      version: 1,
      aliases: value,
    });
    if (!result.ok) throw new Error(result.summary);
    baseline.current = JSON.stringify(value);
    reload();
  });
  useEffect(() => {
    register(node.id, autosave.controller);
    return () => register(node.id, null);
  }, [node.id, register, autosave.controller]);
  useEffect(() => {
    if (JSON.stringify(current.current) === baseline.current) {
      current.current = node.aliases;
      setAliases(node.aliases);
      baseline.current = JSON.stringify(node.aliases);
    }
  }, [node.aliases]);
  return (
    <Table.Tr>
      <Table.Td>
        <Code>{node.id}</Code>
        <Group mt="xs" gap={4} align="flex-start" wrap="nowrap">
          <TagsInput
            aria-label={`Aliases for ${node.id}`}
            style={{ flex: 1, minWidth: 0 }}
            value={aliases}
            maxTags={12}
            error={error}
            onChange={(value) => {
              current.current = value;
              setAliases(value);
              const parsed = commandAliasesSchema.safeParse(value);
              setError(
                parsed.success
                  ? ""
                  : (parsed.error.issues[0]?.message ?? "Check aliases."),
              );
              if (parsed.success) autosave.controller.schedule(parsed.data);
            }}
            onBlur={() => void autosave.controller.flush()}
          />
          <Tooltip label={`Restore defaults for ${node.id}`}>
            <ActionIcon
              variant="subtle"
              aria-label={`Restore defaults for ${node.id}`}
              onClick={() => restore(node)}
            >
              <RotateCcwIcon size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <AutosaveStatus
          state={autosave.state}
          retry={() => autosave.controller.retry()}
        />
      </Table.Td>
      <Table.Td style={{ width: 80, verticalAlign: "top" }}>
        <Group gap={4} wrap="nowrap">
          <Tooltip label={copied ? "Copied" : `Copy /${node.id}`}>
            <ActionIcon
              variant="subtle"
              aria-label={`Copy /${node.id}`}
              onClick={() => {
                try {
                  window.verbo.clipboard.writeText(`/${node.id}`);
                  setCopied(true);
                } catch {
                  setError("Could not copy the command.");
                }
              }}
              onBlur={() => setCopied(false)}
            >
              <CopyIcon size={15} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={`Details for ${node.id}`}>
            <ActionIcon
              variant="subtle"
              aria-label={`Details for ${node.id}`}
              onClick={() => details(node.id)}
            >
              <InfoIcon size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

export function CommandTable({
  moduleId,
  data,
  reload,
  resetWeb,
  onRestored,
}: {
  moduleId: string;
  data: CommandSettings;
  reload: () => Promise<void>;
  resetWeb?: () => Promise<void>;
  onRestored: () => void;
}): ReactElement {
  const confirm = useConfirmation();
  const controllers = useRef(new Map<string, AutosaveController<string[]>>());
  const register = useCallback(
    (id: string, controller: AutosaveController<string[]> | null): void => {
      if (controller) controllers.current.set(id, controller);
      else controllers.current.delete(id);
    },
    [],
  );
  const [epochs, setEpochs] = useState<Record<string, number>>({});
  const [detail, setDetail] = useState<string | null>(null);
  const node = data.nodes.find((item) => item.id === detail);
  const entry = data.entries.find((item) => item.id === detail);
  const metadata = data.metadata.find((item) => item.id === detail);
  const restore = (target: CommandNode): void => {
    void confirm({
      title: "Restore command defaults?",
      message: `Restore aliases for ${target.id}${target.id === moduleId ? " and its child commands" : ""}?${target.id === "web" ? " Web search settings will also return to their defaults." : ""}`,
      confirmLabel: "Restore defaults",
      onConfirm: async () => {
        const affected = data.nodes.filter(
          (item) =>
            item.id === target.id || item.id.startsWith(`${target.id}.`),
        );
        for (const item of affected)
          await controllers.current.get(item.id)?.reset();
        if (target.id === "web") await resetWeb?.();
        await window.verbo.commands.reset(target.id);
        // Fetch before remounting rows so no old alias snapshot is accepted as the new baseline.
        await reload();
        if (target.id === "web") onRestored();
        setEpochs((previous) => ({
          ...previous,
          ...Object.fromEntries(
            affected.map((item) => [item.id, (previous[item.id] ?? 0) + 1]),
          ),
        }));
      },
    });
  };
  return (
    <Stack gap="xs" component="section" aria-label="Command aliases">
      <Text size="sm" fw={500}>
        Commands
      </Text>
      <Text size="xs" c="dimmed">
        Edit aliases directly; press Enter or comma to add a name. Changes save
        automatically.
      </Text>
      <Table.ScrollContainer minWidth={360}>
        <Table verticalSpacing="sm" striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Command and aliases</Table.Th>
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.nodes
              .filter(
                (item) =>
                  item.id === moduleId || item.id.startsWith(`${moduleId}.`),
              )
              .map((item) => (
                <AliasRow
                  key={`${item.id}-${epochs[item.id] ?? 0}`}
                  node={item}
                  register={register}
                  restore={restore}
                  details={setDetail}
                  reload={reload}
                />
              ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <Modal
        opened={!!node}
        onClose={() => setDetail(null)}
        title={node?.id ?? "Command details"}
        size="lg"
        centered
      >
        {node ? (
          <Stack gap="sm">
            <Text size="sm">{node.description}</Text>
            {entry?.syntax ? (
              <Code block>{`/${node.id} ${entry.syntax}`}</Code>
            ) : null}
            {entry?.example ? (
              <Code block>{JSON.stringify(entry.example, null, 2)}</Code>
            ) : null}
            {entry?.kind !== "category" ? (
              <Text size="xs">
                {entry?.kind} ·{" "}
                {entry?.approval === "required"
                  ? "Confirmation required"
                  : "Native command policy applies"}
              </Text>
            ) : null}
            {metadata ? (
              <>
                <Text size="xs">
                  Effect: {metadata.effect} · Files:{" "}
                  {metadata.attachments === "handler_verified"
                    ? "Verified surviving references"
                    : "No file attachments"}
                </Text>
                {Object.entries(metadata.parameterHelp).map(([name, help]) => (
                  <Text size="xs" key={name}>
                    {name}: {help}
                  </Text>
                ))}
                {metadata.requirements.map((requirement) => (
                  <Text size="xs" key={requirement}>
                    {requirement}
                  </Text>
                ))}
                <Text size="xs">
                  Aliases are editable. Canonical identity, execution, effect,
                  output and hard limits are protected.
                </Text>
                <Code block>
                  {JSON.stringify(
                    {
                      args: metadata.args,
                      execution: metadata.execution,
                      output: metadata.output,
                      messages: metadata.messages,
                    },
                    null,
                    2,
                  )}
                </Code>
              </>
            ) : null}
          </Stack>
        ) : null}
      </Modal>
    </Stack>
  );
}
