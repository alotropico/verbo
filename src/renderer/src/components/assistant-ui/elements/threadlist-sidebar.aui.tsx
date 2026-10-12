import { useAui } from "@assistant-ui/react";
import { ActionIcon, UnstyledButton } from "@mantine/core";
import type { ReactElement } from "react";
import { ThreadList } from "@/components/assistant-ui/elements/thread-list.aui";
import { cx } from "@/lib/cx";
import { VerboMark } from "@/components/VerboMark";
import { PanelLeftIcon } from "lucide-react";
import styles from "./threadlist-sidebar.module.css";

export function ThreadListSidebar({
  onToggle,
}: {
  onToggle: () => void;
}): ReactElement {
  const aui = useAui();

  return (
    <>
      <div className={styles.headerRow}>
        <UnstyledButton
          className={styles.identity}
          aria-label="New chat"
          onClick={() => aui.threads().switchToNewThread()}
        >
          <VerboMark className={styles.mark} />
          <span className={styles.brand}>
            verbo<span className={styles.brandDot}>.</span>
          </span>
        </UnstyledButton>
        <ActionIcon
          variant="subtle"
          aria-label="Toggle Sidebar"
          onClick={onToggle}
        >
          <PanelLeftIcon size={18} />
        </ActionIcon>
      </div>
      <div className={cx("aui-sidebar-content", styles.content)}>
        <ThreadList />
      </div>
    </>
  );
}
