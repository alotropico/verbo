import { SettingsNavigationContext } from "./settings-navigation-context";
import {
  useCallback,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

export function SettingsNavigationProvider({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const [opened, setOpened] = useState(false);
  const [tab, setTab] = useState("model");
  const [module, setModule] = useState("general");
  const showChat = useCallback(() => setOpened(false), []);
  const selectModule = useCallback((value: string) => {
    setModule(value);
    setTab("actions");
    setOpened(true);
  }, []);
  const openSettings = useCallback(
    (target?: { tab?: string; module?: string }) => {
      const requested = target?.tab ?? "model";
      if (requested === "memory" || requested === "files") {
        setModule(requested);
        setTab("actions");
      } else {
        setTab(requested === "voice" ? "listening" : requested);
        if (target?.module) setModule(target.module);
      }
      setOpened(true);
    },
    [],
  );
  useEffect(() => {
    const open = (event: Event): void =>
      openSettings(
        (event as CustomEvent<{ tab?: string; module?: string }>).detail ?? {
          tab: "memory",
        },
      );
    window.addEventListener("verbo:open-settings", open);
    return () => window.removeEventListener("verbo:open-settings", open);
  }, [openSettings]);
  return (
    <SettingsNavigationContext
      value={{
        opened,
        tab,
        module,
        showChat,
        openSettings,
        selectTab: setTab,
        selectModule,
      }}
    >
      {children}
    </SettingsNavigationContext>
  );
}
