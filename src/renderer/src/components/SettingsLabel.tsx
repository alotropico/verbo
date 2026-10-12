import { Tooltip } from "@mantine/core";
import { cx } from "@/lib/cx";
import a11y from "@/lib/a11y.module.css";
import { InfoIcon } from "lucide-react";
import type { ReactElement } from "react";
import styles from "./SettingsLabel.module.css";

export function SettingsLabel({
  label,
  tip,
  className,
}: {
  label: string;
  tip: string;
  className?: string;
}): ReactElement {
  return (
    <span className={cx(styles.label, className)}>
      {label}
      <Tooltip label={tip} multiline w={240}>
        <span
          className={styles.tip}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <InfoIcon aria-hidden size={14} />
          <span className={a11y.srOnly}>{tip}</span>
        </span>
      </Tooltip>
    </span>
  );
}
