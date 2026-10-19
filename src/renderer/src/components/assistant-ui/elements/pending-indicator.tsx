import type { ReactElement } from "react";
import { cx } from "@/lib/cx";
import styles from "./pending-indicator.module.css";

export function PendingIndicator({ label }: { label?: string }): ReactElement {
  return (
    <span
      className={styles.dots}
      {...(label
        ? { role: "status" as const, "aria-label": label }
        : { "aria-hidden": true as const })}
    >
      <span className={styles.dot} />
      <span className={cx(styles.dot, styles.dotSecond)} />
      <span className={cx(styles.dot, styles.dotThird)} />
    </span>
  );
}
