import { notifications } from "@mantine/notifications";
import type { StatusTone } from "@/components/StatusMessage";

const COLORS: Record<StatusTone, string> = {
  error: "var(--destructive)",
  info: "var(--muted-foreground)",
  success: "var(--success)",
  warning: "var(--insight)",
};

/** Transient feedback for completed user actions; a shared `id` keeps repeats from stacking. */
export function notify({
  id,
  message,
  tone,
}: {
  id?: string;
  message: string;
  tone: StatusTone;
}): void {
  notifications.show({
    id,
    message,
    color: COLORS[tone],
    autoClose: tone === "error" ? 8000 : 3000,
  });
}
