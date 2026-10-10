import { useSyncExternalStore, type ReactElement } from "react";
import {
  publishCommandStatus,
  readCommandStatus,
  subscribeCommandStatus,
} from "@/runtime/command-status";
import styles from "./CommandNotice.module.css";

export function CommandNotice(): ReactElement | null {
  const current = useSyncExternalStore(
    subscribeCommandStatus,
    readCommandStatus,
  );
  if (!current) return null;
  return (
    <p
      className={current.status === "error" ? styles.error : styles.notice}
      role="status"
    >
      {current.summary}
      <button
        type="button"
        className={styles.dismiss}
        onClick={() => publishCommandStatus(null)}
      >
        Dismiss
      </button>
    </p>
  );
}
