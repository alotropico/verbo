import { useSyncExternalStore, type ReactElement } from "react";
import {
  publishCommandStatus,
  readCommandStatus,
  subscribeCommandStatus,
} from "@/runtime/command-status";
import { StatusMessage } from "./StatusMessage";
import styles from "./CommandNotice.module.css";

export function CommandNotice(): ReactElement | null {
  const current = useSyncExternalStore(
    subscribeCommandStatus,
    readCommandStatus,
  );
  if (!current) return null;
  return (
    <StatusMessage
      action={
        <button
          type="button"
          className={styles.dismiss}
          onClick={() => publishCommandStatus(null)}
        >
          Dismiss
        </button>
      }
      display="outline"
      size="sm"
      tone={current.status === "error" ? "error" : "success"}
    >
      {current.summary}
    </StatusMessage>
  );
}
