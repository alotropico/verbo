import type { ReactElement } from "react";
import { backendNoticeSchema } from "@shared/backend-notice";
import { StatusMessage } from "./StatusMessage";
import styles from "./BackendNotice.module.css";

export function BackendNotice({
  data,
}: {
  data: unknown;
}): ReactElement | null {
  const parsed = backendNoticeSchema.safeParse(data);
  if (!parsed.success) return null;
  const notice = parsed.data;
  return (
    <StatusMessage
      className={styles.notice}
      display="outline"
      size="sm"
      tone={notice.severity}
    >
      {notice.message}
    </StatusMessage>
  );
}
