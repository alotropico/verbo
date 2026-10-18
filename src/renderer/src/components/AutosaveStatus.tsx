import { ActionIcon, Group, Text, Tooltip } from "@mantine/core";
import { RotateCwIcon } from "lucide-react";
import type { ReactElement } from "react";
import type { AutosaveState } from "@/runtime/autosave";

export function AutosaveStatus({
  state,
  retry,
}: {
  state: AutosaveState;
  retry: () => void;
}): ReactElement | null {
  if (state.status !== "error") return null;
  return (
    <Group gap="xs" role="alert">
      <Text size="xs" c="var(--destructive)">
        {state.error}
      </Text>
      <Tooltip
        label="Retry saving"
        events={{ hover: true, focus: true, touch: false }}
      >
        <ActionIcon variant="subtle" aria-label="Retry saving" onClick={retry}>
          <RotateCwIcon size={14} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
