import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import type { ReactElement, ReactNode } from "react";
import { cssVariablesResolver, theme } from "./mantine";

export function ThemeProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
      forceColorScheme="dark"
    >
      <Notifications position="bottom-right" limit={3} />
      {children}
    </MantineProvider>
  );
}
