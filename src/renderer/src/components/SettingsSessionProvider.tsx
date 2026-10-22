import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { SettingsSession } from "@/runtime/settings-session";
import { SettingsSessionContext } from "@/hooks/settings-session-context";
import { notify } from "@/lib/notify";

const notifySaved = (): void => notify({ id: "settings-saved", message: "Changes saved", tone: "success" });

export function SettingsSessionProvider({ children }: { children: ReactNode }): ReactElement {
  const [session] = useState(() => new SettingsSession(notifySaved));
  useEffect(() => {
    const flush = (): void => {
      void session.flush();
    };
    const entitiesChanged = (): void => {
      session.invalidateResources("entities");
      session.invalidateResources("files");
      session.invalidateResources("overview");
    };
    const memoryChanged = (): void => session.invalidateResources("memory/");
    window.addEventListener("blur", flush);
    window.addEventListener("verbo:entities-changed", entitiesChanged);
    window.addEventListener("verbo:memory-changed", memoryChanged);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("verbo:entities-changed", entitiesChanged);
      window.removeEventListener("verbo:memory-changed", memoryChanged);
      flush();
    };
  }, [session]);
  return <SettingsSessionContext value={session}>{children}</SettingsSessionContext>;
}
