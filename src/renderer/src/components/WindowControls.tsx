import { ActionIcon, Group, Tooltip } from "@mantine/core";
import { CopyIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import type { WindowState } from "@shared/window-controls";
import { cx } from "@/lib/cx";
import styles from "./WindowControls.module.css";

export function WindowControls(): ReactElement | null {
  const [state, setState] = useState<WindowState | null>(null);

  useEffect(() => {
    let active = true;
    let receivedUpdate = false;
    const unsubscribe = window.verbo.window.subscribe((next) => {
      receivedUpdate = true;
      if (active) setState(next);
    });
    void window.verbo.window.getState().then((initial) => {
      if (active && !receivedUpdate) setState(initial);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (!state || state.nativeControls) return null;

  const maximizeLabel = state.maximized ? "Restore window" : "Maximize window";
  const tooltipEvents = { hover: true, focus: true, touch: false };

  return (
    <Group
      className={styles.controls}
      gap={4}
      wrap="nowrap"
      role="group"
      aria-label="Window controls"
    >
      <Tooltip label="Minimize window" events={tooltipEvents}>
        <ActionIcon
          className={styles.control}
          variant="transparent"
          size={32}
          aria-label="Minimize window"
          onClick={() => window.verbo.window.minimize()}
        >
          <MinusIcon size={16} strokeWidth={1.5} aria-hidden="true" />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={maximizeLabel} events={tooltipEvents}>
        <ActionIcon
          className={styles.control}
          variant="transparent"
          size={32}
          aria-label={maximizeLabel}
          onClick={() => window.verbo.window.toggleMaximize()}
        >
          {state.maximized ? (
            <CopyIcon size={14} strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <SquareIcon size={14} strokeWidth={1.5} aria-hidden="true" />
          )}
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Close window" events={tooltipEvents}>
        <ActionIcon
          className={cx(styles.control, styles.close)}
          variant="transparent"
          size={32}
          aria-label="Close window"
          onClick={() => window.verbo.window.close()}
        >
          <XIcon size={16} strokeWidth={1.5} aria-hidden="true" />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
