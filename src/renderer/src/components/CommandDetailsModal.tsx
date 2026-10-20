import {
  ActionIcon,
  Badge,
  Code,
  Group,
  List,
  Modal,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  TerminalIcon,
} from "lucide-react";
import { useState, type ReactElement } from "react";
import type { CommandNode, CommandSettings } from "@shared/commands";
import { commandParameterDetails } from "./command-parameter-details";
import { SettingsDisclosure } from "./SettingsDisclosure";
import styles from "./CommandDetailsModal.module.css";

function DetailsCode({
  label,
  value,
  commandId,
}: {
  label: string;
  value: string;
  commandId: string;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  return (
    <Stack gap="xs" component="section" aria-label={label}>
      <Group justify="space-between">
        <Text component="h3" size="sm" fw={500} m={0}>
          {label}
        </Text>
        <Tooltip
          label={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
          events={{ hover: true, focus: true, touch: false }}
        >
          <ActionIcon
            variant="subtle"
            aria-label={`Copy ${label.toLowerCase()} for ${commandId}`}
            onClick={async () => {
              try {
                await window.verbo.clipboard.writeText(value);
                setCopied(true);
                setError("");
              } catch {
                setError("Could not copy this text.");
              }
            }}
            onBlur={() => setCopied(false)}
          >
            {copied ? (
              <CheckIcon size={16} aria-hidden />
            ) : (
              <CopyIcon size={16} aria-hidden />
            )}
          </ActionIcon>
        </Tooltip>
      </Group>
      <Code block color="var(--background)" className={styles.codeBlock}>
        {value}
      </Code>
      {error ? (
        <Text size="xs" c="var(--destructive)" role="alert">
          {error}
        </Text>
      ) : null}
    </Stack>
  );
}

function CommandDetails({
  node,
  data,
  onSelect,
}: {
  node: CommandNode;
  data: CommandSettings;
  onSelect: (id: string) => void;
}): ReactElement {
  const entry = data.entries.find((item) => item.id === node.id);
  const metadata = data.metadata.find((item) => item.id === node.id);
  const children = data.nodes.filter(
    (item) =>
      item.id.startsWith(`${node.id}.`) &&
      !item.id.slice(node.id.length + 1).includes("."),
  );
  const isGroup =
    entry?.kind === "category" || (!metadata && children.length > 0);
  const parameters = commandParameterDetails(
    metadata?.args ?? entry?.args,
    metadata?.parameterHelp,
  );
  const effects = {
    read: "Reads data",
    write: "Changes data",
    launch: "Opens an application",
    process: "Runs a process",
  };
  return (
    <Stack gap="lg">
      <Stack gap="sm">
        <Text size="sm" className={styles.description}>
          {node.description}
        </Text>
        <Group gap="xs">
          {isGroup ? (
            <Badge variant="light" tt="none">
              Command group
            </Badge>
          ) : metadata ? (
            <Badge variant="light" tt="none">
              {effects[metadata.effect]}
            </Badge>
          ) : null}
          {!isGroup && entry?.approval ? (
            <Badge variant="outline" tt="none" color="var(--muted-foreground)">
              {entry.approval === "required"
                ? "Confirmation required"
                : "No confirmation required"}
            </Badge>
          ) : null}
        </Group>
        {metadata ? (
          <Text size="xs" c="dimmed">
            {metadata.attachments === "handler_verified"
              ? "File references are verified before they are returned."
              : "Does not return file attachments."}
          </Text>
        ) : null}
      </Stack>
      {node.aliases.length ? (
        <Stack gap="xs" component="section" aria-label="Aliases">
          <Text component="h3" size="sm" fw={500} m={0}>
            Aliases
          </Text>
          <Group gap="xs">
            {node.aliases.map((alias) => (
              <Code key={alias} color="var(--surface)" className={styles.alias}>
                {alias}
              </Code>
            ))}
          </Group>
        </Stack>
      ) : null}
      {!isGroup || entry?.syntax ? (
        <DetailsCode
          label="Usage"
          commandId={node.id}
          value={`/${node.id}${entry?.syntax ? ` ${entry.syntax}` : ""}`}
        />
      ) : null}
      {parameters.length ? (
        <Stack gap="xs" component="section" aria-label="Parameters">
          <Text component="h3" size="sm" fw={500} m={0}>
            Parameters
          </Text>
          <Stack component="dl" gap={0} m={0}>
            {parameters.map((parameter) => (
              <Stack key={parameter.name} gap={4} className={styles.parameter}>
                <Group component="dt" justify="space-between" gap="xs">
                  <Code color="transparent" p={0}>
                    {parameter.name}
                  </Code>
                  <Text
                    size="xs"
                    c={parameter.required ? "var(--primary)" : "dimmed"}
                  >
                    {parameter.required ? "Required" : "Optional"}
                  </Text>
                </Group>
                <Stack component="dd" gap={4} m={0}>
                  {parameter.description ? (
                    <Text size="sm">{parameter.description}</Text>
                  ) : null}
                  {parameter.type || parameter.limits.length ? (
                    <Text size="xs" c="dimmed">
                      {[parameter.type, ...parameter.limits]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  ) : null}
                  {parameter.choices.length ? (
                    <Group gap={4}>
                      <Text size="xs" c="dimmed">
                        Choices:
                      </Text>
                      {parameter.choices.map((choice) => (
                        <Code
                          key={choice}
                          color="var(--surface)"
                          className={styles.alias}
                        >
                          {choice}
                        </Code>
                      ))}
                    </Group>
                  ) : null}
                  {parameter.defaultValue !== undefined ? (
                    <Text size="xs" c="dimmed">
                      Default:{" "}
                      <Code color="var(--surface)" className={styles.alias}>
                        {parameter.defaultValue}
                      </Code>
                    </Text>
                  ) : null}
                </Stack>
              </Stack>
            ))}
          </Stack>
        </Stack>
      ) : null}
      {entry?.example ? (
        <DetailsCode
          label="Example arguments"
          commandId={node.id}
          value={JSON.stringify(entry.example, null, 2)}
        />
      ) : null}
      {metadata &&
      (metadata.requirements.length ||
        metadata.attachments === "handler_verified") ? (
        <Stack gap="xs" component="section" aria-label="Requirements and files">
          <Text component="h3" size="sm" fw={500} m={0}>
            Requirements and files
          </Text>
          <List size="sm" spacing="xs">
            {metadata.requirements.map((requirement) => (
              <List.Item key={requirement}>{requirement}</List.Item>
            ))}
            {metadata.attachments === "handler_verified" ? (
              <List.Item>Can return verified file references.</List.Item>
            ) : null}
          </List>
        </Stack>
      ) : null}
      {children.length ? (
        <Stack gap="xs" component="section" aria-label="Commands in this group">
          <Text component="h3" size="sm" fw={500} m={0}>
            Commands in this group
          </Text>
          {children.map((child) => (
            <UnstyledButton
              key={child.id}
              className={styles.childCommand}
              onClick={() => onSelect(child.id)}
            >
              <Stack gap={4} className={styles.childDescription}>
                <Code color="transparent" p={0}>
                  {child.id}
                </Code>
                <Text size="xs" c="dimmed">
                  {child.description}
                </Text>
              </Stack>
              <ChevronRightIcon size={16} aria-hidden />
            </UnstyledButton>
          ))}
        </Stack>
      ) : null}
      {metadata ? (
        <SettingsDisclosure title="Technical details">
          <Text size="xs" c="dimmed">
            Aliases are editable in the table. Command identity, execution and
            limits are protected.
          </Text>
          <DetailsCode
            label="Command definition"
            commandId={node.id}
            value={JSON.stringify(
              {
                args: metadata.args,
                execution: metadata.execution,
                output: metadata.output,
                messages: metadata.messages,
                attachments: metadata.attachments,
              },
              null,
              2,
            )}
          />
        </SettingsDisclosure>
      ) : null}
    </Stack>
  );
}

export function CommandDetailsModal({
  opened,
  node,
  data,
  onClose,
  onExitTransitionEnd,
  onSelect,
}: {
  opened: boolean;
  node?: CommandNode;
  data: CommandSettings;
  onClose: () => void;
  onExitTransitionEnd: () => void;
  onSelect: (id: string) => void;
}): ReactElement {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      onExitTransitionEnd={onExitTransitionEnd}
      title={
        <Group component="span" gap="sm" wrap="nowrap">
          <TerminalIcon size={20} aria-hidden className={styles.titleIcon} />
          <Text component="span" className={styles.commandName}>
            {node?.id ?? "Command details"}
          </Text>
        </Group>
      }
      size="lg"
      centered
      yOffset="var(--mantine-spacing-md)"
      classNames={{
        content: styles.content,
        header: styles.header,
        title: styles.title,
        body: styles.body,
      }}
      closeButtonProps={{ "aria-label": "Close command details" }}
    >
      {node ? (
        <CommandDetails
          key={node.id}
          node={node}
          data={data}
          onSelect={onSelect}
        />
      ) : null}
    </Modal>
  );
}
