import type { ReactElement } from "react";
import { Button, Text } from "@mantine/core";
import { z } from "zod";
import { stageEventSchema } from "@shared/workflows";
import { routingStageSchema } from "@shared/workflows";
import { useAuiState } from "@assistant-ui/react";
import {
  CollapsibleRoot,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./assistant-ui/elements/collapsible-root";
import { StatusMessage } from "./StatusMessage";

export function WorkflowRoutingNotice({
  data,
}: {
  data: unknown;
}): ReactElement | null {
  const parsed = routingStageSchema.safeParse(data);
  if (!parsed.success) return null;
  const stage = parsed.data;
  return (
    <Text size="xs" c="dimmed">
      Decision · {stage.state}
      {stage.workflowId
        ? ` · ${stage.workflowId}`
        : stage.disposition
          ? ` · ${stage.disposition}`
          : ""}
    </Text>
  );
}

export function WorkflowStageNotice({
  data,
}: {
  data: unknown;
}): ReactElement | null {
  const parsed = stageEventSchema.safeParse(data);
  if (!parsed.success) return null;
  const stage = parsed.data;
  const attribution = stage.attribution;
  return (
    <CollapsibleRoot>
      <CollapsibleTrigger render={<Button variant="subtle" size="xs" />}>
        {stage.label} · {stage.state}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Text size="xs">
          {attribution.workflowId} v{attribution.definitionVersion} ·{" "}
          {attribution.agentId ?? "branch"} ·{" "}
          {attribution.modelProfileId ?? "deterministic"}
        </Text>
        <Text size="xs">Execution: {attribution.executionId}</Text>
        <Text size="xs">Step run: {attribution.stepRunId}</Text>
        {stage.summary ? <Text size="sm">{stage.summary}</Text> : null}
      </CollapsibleContent>
    </CollapsibleRoot>
  );
}

const executionSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  revision: z.number(),
  status: z.string(),
  reason: z.string().optional(),
  question: z.object({ text: z.string() }).optional(),
});
export function WorkflowExecutionNotice({
  data,
}: {
  data: unknown;
}): ReactElement | null {
  const parsed = executionSchema.safeParse(data);
  const latestRevision = useAuiState((state) =>
    state.thread.messages.reduce(
      (revision, message) =>
        message.content.reduce((value, part) => {
          if (part.type !== "data" || part.name !== "workflow-execution")
            return value;
          const entry = executionSchema.safeParse(part.data);
          return entry.success &&
            parsed.success &&
            entry.data.id === parsed.data.id
            ? Math.max(value, entry.data.revision)
            : value;
        }, revision),
      0,
    ),
  );
  if (
    !parsed.success ||
    parsed.data.status === "completed" ||
    latestRevision > parsed.data.revision
  )
    return null;
  const execution = parsed.data;
  return (
    <StatusMessage tone="warning" display="outline" size="sm">
      {execution.workflowId}: {execution.status}
      {execution.reason ? ` (${execution.reason.replace(/_/gu, " ")})` : ""}.
      <Text size="xs">
        Resume reference: {execution.id} · revision {execution.revision}
      </Text>
      {execution.question ? (
        <Text size="sm">{execution.question.text}</Text>
      ) : null}
    </StatusMessage>
  );
}
