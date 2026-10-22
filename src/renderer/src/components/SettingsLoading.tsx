import { Button, Group, Loader, Stack, Text } from "@mantine/core";
import type { ReactElement } from "react";
import { StatusMessage } from "./StatusMessage";

export function SettingsLoading({ label, error = "", retry }: { label: string; error?: string; retry?: () => void }): ReactElement {
  return error ? (
    <Stack gap="xs">
      <StatusMessage display="outline" tone="error">
        {error}
      </StatusMessage>
      {retry ? (
        <Button variant="default" size="xs" onClick={retry}>
          Try again
        </Button>
      ) : null}
    </Stack>
  ) : (
    <Group role="status" aria-live="polite" aria-busy="true" gap="sm" p="md">
      <Loader size="sm" color="var(--primary)" aria-hidden />
      <Text size="sm" c="dimmed">
        {label}
      </Text>
    </Group>
  );
}
