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
}): ReactElement {
  return (
    <Group gap="xs" role={state.status === "error" ? "alert" : "status"}>
      <Text
        size="xs"
        c={state.status === "error" ? "var(--destructive)" : "dimmed"}
      >
        {state.status === "error"
          ? state.error
          : state.status === "saving"
            ? "Saving…"
            : state.status === "saved"
              ? "Saved automatically"
              : "Changes save automatically"}
      </Text>
      {state.status === "error" ? (
        <Tooltip
          label="Retry saving"
          events={{ hover: true, focus: true, touch: false }}
        >
          <ActionIcon
            variant="subtle"
            aria-label="Retry saving"
            onClick={retry}
          >
            <RotateCwIcon size={14} />
          </ActionIcon>
        </Tooltip>
      ) : null}
    </Group>
  );
}
