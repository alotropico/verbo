import { useState, type ReactElement } from "react";
import { Button } from "@mantine/core";
import { z } from "zod";
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

const savingErrorSchema = z.object({
  turnId: z.string(),
  threadId: z.string(),
  assistantMessageId: z.string(),
  message: z.string().optional(),
});

export function FinalizationNotice({
  data,
}: {
  data: unknown;
}): ReactElement | null {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const parsed = savingErrorSchema.safeParse(data);
  if (!parsed.success) return null;
  const identity = parsed.data;
  return (
    <StatusMessage
      className={styles.notice}
      display="outline"
      size="sm"
      tone="error"
    >
      Response saving is paused. {error ?? identity.message}
      <Button
        size="xs"
        variant="subtle"
        loading={saving}
        onClick={() => {
          setSaving(true);
          void window.verbo.turns
            .retrySaving({
              turnId: identity.turnId,
              threadId: identity.threadId,
              assistantMessageId: identity.assistantMessageId,
            })
            .then((saved) => {
              if (!saved) setError("The response still could not be saved.");
            })
            .catch(() =>
              setError("Storage is unavailable. You can retry saving."),
            )
            .finally(() => setSaving(false));
        }}
      >
        Retry saving response
      </Button>
    </StatusMessage>
  );
}
