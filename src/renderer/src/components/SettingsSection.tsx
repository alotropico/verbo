import { Stack, Text } from "@mantine/core";
import type { ReactElement, ReactNode } from "react";

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <Stack component="section" aria-label={title} gap="md">
      <Stack gap={4}>
        <Text component="h3" size="md" fw={500} m={0}>
          {title}
        </Text>
        {description ? (
          <Text size="sm" c="dimmed">
            {description}
          </Text>
        ) : null}
      </Stack>
      {children}
    </Stack>
  );
}
