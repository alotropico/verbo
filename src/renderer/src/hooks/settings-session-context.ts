import { createContext, useContext } from "react";
import type { SettingsSession } from "@/runtime/settings-session";

export const SettingsSessionContext = createContext<SettingsSession | null>(
  null,
);

export function useSettingsSession(): SettingsSession {
  const session = useContext(SettingsSessionContext);
  if (!session)
    throw new Error("Settings views require a SettingsSessionProvider.");
  return session;
}
