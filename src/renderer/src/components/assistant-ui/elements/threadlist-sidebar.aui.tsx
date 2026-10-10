import { ActionIcon } from "@mantine/core";
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
  return (
    <>
      <div className={styles.headerRow}>
        <div className={styles.identity}>
          <VerboMark className={styles.mark} />
          <span className={styles.brand}>
            verbo<span className={styles.brandDot}>.</span>
          </span>
        </div>
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
      <footer className={styles.footer}>
        <span className={styles.shortcut}>
          <kbd>Ctrl</kbd> + <kbd>B</kbd> to fold away
        </span>
      </footer>
    </>
  );
}
