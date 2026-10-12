import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { ThreadListSidebar } from "@/components/assistant-ui/elements/threadlist-sidebar.aui";
import {
  ChatSelectionBar,
  ChatSelectionProvider,
} from "@/components/ChatSelection";
import { QueueSidebar } from "@/components/QueueSidebar";
import { ServiceControls } from "@/components/ServiceControls";
import { WindowControls } from "@/components/WindowControls";
import { VerboRuntimeProvider } from "@/runtime/VerboRuntimeProvider";
import { useAui, useAuiState, type AssistantState } from "@assistant-ui/react";
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
  const aui = useAui();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = event.metaKey || event.ctrlKey;
      if (!command) return;
      if (event.key === "b") {
        event.preventDefault();
        if (isMobile) toggleMobile();
        else toggleDesktop();
        return;
      }
      if (event.key !== "n" || event.altKey || event.shiftKey || event.repeat) {
        return;
      }
      if (document.querySelector("[role='dialog']")) return;
      event.preventDefault();
      aui.threads().switchToNewThread();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [aui, isMobile, toggleMobile, toggleDesktop]);

  const toggleSidebar = isMobile ? toggleMobile : toggleDesktop;
  const showHeaderToggle = isMobile || !desktopOpened;

  return (
    <ChatSelectionProvider>
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
          <header className={styles.header} data-window-chrome>
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
            <ServiceControls />
            <span className={styles.headerDivider} aria-hidden="true" />
            <WindowControls />
          </header>
          <div className={styles.main}>
            <ChatSelectionBar />
            <div className={styles.threadPane}>
              <Thread />
              <QueueSidebar />
            </div>
          </div>
        </AppShell.Main>
      </AppShell>
    </ChatSelectionProvider>
  );
}

export default function App(): ReactElement {
  return (
    <VerboRuntimeProvider>
      <VerboShell />
    </VerboRuntimeProvider>
  );
}
