import { RuntimeAdapterProvider } from "@assistant-ui/react";
import type { PropsWithChildren, ReactElement } from "react";
import { useThreadAdapters } from "./thread-adapters";

export function ThreadAdaptersProvider({
  children,
}: PropsWithChildren): ReactElement {
  const adapters = useThreadAdapters();
  return (
    <RuntimeAdapterProvider adapters={adapters}>
      {children}
    </RuntimeAdapterProvider>
  );
}
