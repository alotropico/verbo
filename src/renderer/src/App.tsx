import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { ThreadListSidebar } from "@/components/assistant-ui/elements/threadlist-sidebar.aui";
import { ContextMeters } from "@/components/ContextMeters";
import { OllamaStatusBanner } from "@/components/OllamaStatusBanner";
import { SettingsPanel } from "@/components/SettingsPanel";
import { VerboRuntimeProvider } from "@/runtime/VerboRuntimeProvider";
import { useAuiState, type AssistantState } from "@assistant-ui/react";
import { chatPlaceholderTitle } from "@shared/thread-title";
import { ActionIcon, AppShell } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { PanelLeftIcon } from "lucide-react";
import { useEffect, type ReactElement } from "react";
import styles from "./App.module.css";

function currentThreadTitle(state: AssistantState): string {
  const items = state.threads.threadItems;
  if (!Array.isArray(items)) return "";

  const current = items.find((item) => item.id === state.threads.mainThreadId);
  if (!current) return "";

  const title = current.title?.trim() ?? "";
  const placeholder = chatPlaceholderTitle(current.id);
  const requested = title.length > 0 && title !== placeholder;
  const isNewChat =
    state.thread.messages.length === 0 &&
    (!state.thread.isLoading || state.threads.isLoading);

  if (isNewChat && !requested) return "";
  return requested ? title : placeholder;
}

function ShellTitle(): ReactElement {
  const title = useAuiState(currentThreadTitle);
  if (!title) return <span className={styles.headerSpacer} />;
  return <h1 className={styles.headerTitle}>{title}</h1>;
}

function VerboShell(): ReactElement {
  const isMobile = useMediaQuery("(max-width: 47.99em)", false, {
    getInitialValueInEffect: false,
  });
  const [mobileOpened, { toggle: toggleMobile }] = useDisclosure(false);
  const [desktopOpened, { toggle: toggleDesktop }] = useDisclosure(true);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "b" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (isMobile) toggleMobile();
      else toggleDesktop();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobile, toggleMobile, toggleDesktop]);

  const toggleSidebar = isMobile ? toggleMobile : toggleDesktop;
  const showHeaderToggle = isMobile || !desktopOpened;
  const sidebarHidden = isMobile ? !mobileOpened : !desktopOpened;

  return (
    <AppShell
      className={styles.shell}
      padding={0}
      navbar={{
        width: 248,
        breakpoint: "sm",
        collapsed: { mobile: !mobileOpened, desktop: !desktopOpened },
      }}
    >
      <AppShell.Navbar withBorder={false} className={styles.navbar} p={0}>
        <ThreadListSidebar onToggle={toggleSidebar} />
      </AppShell.Navbar>
      <AppShell.Main className={styles.inset}>
        <header className={styles.header}>
          {showHeaderToggle ? (
            <ActionIcon
              variant="subtle"
              aria-label="Toggle Sidebar"
              onClick={toggleSidebar}
            >
              <PanelLeftIcon size={18} />
            </ActionIcon>
          ) : null}
          <ShellTitle />
          {sidebarHidden ? <ContextMeters compact /> : null}
          <OllamaStatusBanner />
          <SettingsPanel />
        </header>
        <div className={styles.main}>
          <Thread />
        </div>
      </AppShell.Main>
    </AppShell>
  );
}

export default function App(): ReactElement {
  return (
    <VerboRuntimeProvider>
      <VerboShell />
    </VerboRuntimeProvider>
  );
}
