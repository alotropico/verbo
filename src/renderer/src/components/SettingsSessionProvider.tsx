import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { SettingsSession } from "@/runtime/settings-session";
import { SettingsSessionContext } from "@/hooks/settings-session-context";
import { notify } from "@/lib/notify";

const notifySaved = (): void =>
  notify({ id: "settings-saved", message: "Changes saved", tone: "success" });

export function SettingsSessionProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const [session] = useState(() => new SettingsSession(notifySaved));
  useEffect(() => {
    const flush = (): void => {
      void session.flush();
    };
    window.addEventListener("blur", flush);
    return () => {
      window.removeEventListener("blur", flush);
      flush();
    };
  }, [session]);
  return (
    <SettingsSessionContext value={session}>{children}</SettingsSessionContext>
  );
}
