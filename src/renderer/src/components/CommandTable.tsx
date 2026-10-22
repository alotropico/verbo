import { useSettingsAutosave, useSettingsDraft, useSettingsRef } from "@/hooks/use-settings-draft";
import { ActionIcon, Code, Group, Stack, Table, TagsInput, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { commandAliasesSchema, type CommandNode, type CommandSettings } from "@shared/commands";
import { CheckIcon, CopyIcon, InfoIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState, type ReactElement } from "react";
import { AutosaveStatus } from "./AutosaveStatus";
import { CommandDetailsModal } from "./CommandDetailsModal";
import styles from "./CommandTable.module.css";
import { useConfirmation } from "./confirmation-context";

function AliasRow({
  node,
  restore,
  details,
  reload,
}: {
  node: CommandNode;
  restore: (node: CommandNode) => void;
  details: (id: string) => void;
  reload: () => void;
}): ReactElement {
  const key = `command-alias/${node.id}/`;
  const [aliases, setAliases] = useSettingsDraft(key + "aliases", node.aliases);
  const [error, setError] = useSettingsDraft(key + "error", "");
  const [search, setSearch] = useSettingsDraft(key + "search", "");
  const [copied, setCopied] = useState(false);
  const currentRef = useSettingsRef(key + "current", aliases);
  const baselineRef = useSettingsRef(key + "baseline", JSON.stringify(node.aliases));
  const autosave = useSettingsAutosave<string[]>(
    key + "save",
    async (value) => {
      const result = await window.verbo.commands.save({
        nodeId: node.id,
        version: 1,
        aliases: value,
      });
      if (!result.ok) throw new Error(result.summary);
      baselineRef.current = JSON.stringify(value);
      reload();
    },
    undefined,
    node.aliases,
  );
  const synchronize = useEffectEvent(() => {
    if (autosave.state.status === "saving" || autosave.state.status === "error") return;
    if (JSON.stringify(currentRef.current) === baselineRef.current) {
      currentRef.current = node.aliases;
      setAliases(node.aliases);
      baselineRef.current = JSON.stringify(node.aliases);
      autosave.controller.acceptBaseline(node.aliases);
    }
  });
  useEffect(() => {
    synchronize();
  }, [node.aliases]);
  return (
    <Table.Tr>
      <Table.Td className={styles.commandCell}>
        <Tooltip label={copied ? "Copied" : `Copy /${node.id}`} events={{ hover: true, focus: true, touch: false }}>
          <UnstyledButton
            className={styles.copyCommand}
            data-copied={copied || undefined}
            aria-label={`Copy /${node.id}`}
            onClick={async () => {
              try {
                await window.verbo.clipboard.writeText(`/${node.id}`);
                setCopied(true);
              } catch {
                setError("Could not copy the command.");
              }
            }}
            onBlur={() => setCopied(false)}
          >
            <Code color="transparent" c="inherit" p={0} fw={500}>
              {node.id}
            </Code>
            {copied ? (
              <CheckIcon aria-hidden size={14} className={styles.copyIndicator} />
            ) : (
              <CopyIcon aria-hidden size={14} className={styles.copyIndicator} />
            )}
          </UnstyledButton>
        </Tooltip>
      </Table.Td>
      <Table.Td>
        <Group gap="xs" align="center" wrap="nowrap">
          <TagsInput
            aria-label={`Aliases for ${node.id}`}
            className={styles.aliases}
            value={aliases}
            searchValue={search}
            onSearchChange={setSearch}
            maxTags={12}
            placeholder={aliases.length ? undefined : "Add an alias…"}
            error={error}
            onChange={(value) => {
              currentRef.current = value;
              setAliases(value);
              const parsed = commandAliasesSchema.safeParse(value);
              setError(parsed.success ? "" : (parsed.error.issues[0]?.message ?? "Check aliases."));
              if (parsed.success) autosave.controller.schedule(parsed.data);
            }}
            onBlur={() => void autosave.controller.flush()}
          />
          <Tooltip label={`Restore defaults for ${node.id}`} events={{ hover: true, focus: true, touch: false }}>
            <ActionIcon
              variant="subtle"
              className={styles.rowAction}
              aria-label={`Restore defaults for ${node.id}`}
              onClick={() => restore(node)}
            >
              <RotateCcwIcon size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
        {autosave.state.status === "saving" || autosave.state.status === "error" ? (
          <AutosaveStatus state={autosave.state} retry={() => autosave.controller.retry()} />
        ) : null}
      </Table.Td>
      <Table.Td className={styles.detailsCell}>
        <Tooltip label={`Details for ${node.id}`} events={{ hover: true, focus: true, touch: false }}>
          <ActionIcon variant="subtle" className={styles.rowAction} aria-label={`Details for ${node.id}`} onClick={() => details(node.id)}>
            <InfoIcon size={15} />
          </ActionIcon>
        </Tooltip>
      </Table.Td>
    </Table.Tr>
  );
}

export function CommandTable({
  moduleId,
  data,
  reload,
  resetAliases,
  epochs,
  onRestored,
}: {
  moduleId?: string;
  data: CommandSettings;
  reload: () => Promise<void>;
  resetAliases: (ids: string[]) => Promise<void>;
  epochs: Record<string, number>;
  onRestored: (id: string) => void;
}): ReactElement {
  const confirm = useConfirmation();
  const [detail, setDetail] = useState<{
    opened: boolean;
    node: CommandNode;
    data: CommandSettings;
  } | null>(null);
  const showDetails = (id: string): void => {
    const node = data.nodes.find((item) => item.id === id);
    if (node) setDetail({ opened: true, node, data });
  };
  const restore = (target: CommandNode): void => {
    const affected = data.nodes.filter((item) => item.id === target.id || item.id.startsWith(`${target.id}.`));
    void confirm({
      title: "Restore command defaults?",
      message: `Restore aliases for ${target.id}${affected.length > 1 ? " and its child commands" : ""}?`,
      confirmLabel: "Restore defaults",
      onConfirm: async () => {
        await resetAliases(affected.map((item) => item.id));
        await window.verbo.commands.reset(target.id);
        // Fetch before remounting rows so no old alias snapshot is accepted as the new baseline.
        await reload();
        onRestored(target.id);
      },
    });
  };
  return (
    <Stack gap="sm" component="section" aria-label="Command aliases">
      <Text size="xs" c="dimmed">
        Click a command to copy it. Add aliases with Enter or comma.
      </Text>
      <Table.ScrollContainer
        minWidth={560}
        scrollAreaProps={{
          type: "auto",
          scrollbars: "x",
          classNames: { viewport: styles.tableViewport },
        }}
      >
        <Table
          verticalSpacing="sm"
          horizontalSpacing="sm"
          borderColor="var(--sidebar-border)"
          highlightOnHover
          highlightOnHoverColor="var(--accent)"
          classNames={{ th: styles.columnHeading, tr: styles.commandRow }}
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Command</Table.Th>
              <Table.Th>Aliases</Table.Th>
              <Table.Th>Details</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.nodes
              .filter((item) => !moduleId || item.id === moduleId || item.id.startsWith(`${moduleId}.`))
              .map((item) => (
                <AliasRow key={`${item.id}-${epochs[item.id] ?? 0}`} node={item} restore={restore} details={showDetails} reload={reload} />
              ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <CommandDetailsModal
        opened={detail?.opened ?? false}
        node={detail?.node}
        data={detail?.data ?? data}
        onClose={() => setDetail((current) => current && { ...current, opened: false })}
        onExitTransitionEnd={() => setDetail((current) => (current?.opened ? current : null))}
        onSelect={showDetails}
      />
    </Stack>
  );
}
