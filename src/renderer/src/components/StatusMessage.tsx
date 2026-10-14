import { cx } from "@/lib/cx";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import styles from "./StatusMessage.module.css";

export type StatusTone = "error" | "warning" | "success" | "info";
export type StatusSize = "xs" | "sm" | "md";
export type StatusDisplay = "plain" | "outline";

export type StatusFeedback = {
  text: string;
  tone: StatusTone;
};

const ICONS: Record<StatusTone, LucideIcon> = {
  error: CircleAlertIcon,
  info: InfoIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
};

const ICON_SIZE: Record<StatusSize, number> = {
  md: 16,
  sm: 14,
  xs: 12,
};

export function StatusMessage({
  action,
  children,
  className,
  display = "plain",
  role,
  size = "sm",
  tone,
}: {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  display?: StatusDisplay;
  /** `false` when a parent already exposes alert or status. */
  role?: "alert" | "status" | false;
  size?: StatusSize;
  tone: StatusTone;
}): ReactElement {
  const Icon = ICONS[tone];
  const announced =
    role === false
      ? undefined
      : (role ?? (tone === "error" ? "alert" : "status"));
  return (
    <div
      className={cx(
        styles.root,
        styles[tone],
        styles[size],
        styles[display],
        className,
      )}
      role={announced}
    >
      <Icon aria-hidden className={styles.icon} size={ICON_SIZE[size]} />
      <span className={styles.body}>
        {children}
        {action}
      </span>
    </div>
  );
}
