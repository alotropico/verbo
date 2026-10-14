import { createContext, useContext } from "react";
export type Navigation = {
  opened: boolean;
  tab: string;
  module: string;
  showChat: () => void;
  openSettings: (target?: { tab?: string; module?: string }) => void;
  selectTab: (tab: string) => void;
  selectModule: (module: string) => void;
};
export const SettingsNavigationContext = createContext<Navigation | null>(null);

export function useSettingsNavigation(): Navigation {
  const navigation = useContext(SettingsNavigationContext);
  if (!navigation) throw new Error("SettingsNavigationProvider is missing.");
  return navigation;
}
