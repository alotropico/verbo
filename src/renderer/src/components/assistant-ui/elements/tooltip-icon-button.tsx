"use client";

import { ActionIcon, Tooltip, type ActionIconProps } from "@mantine/core";
import { type ComponentPropsWithoutRef, forwardRef } from "react";

import { cx } from "@/lib/cx";
import a11y from "@/lib/a11y.module.css";
import styles from "./tooltip-icon-button.module.css";

export type TooltipIconButtonProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "color"
> &
  Omit<ActionIconProps, "variant"> & {
    tooltip: string;
    side?: "top" | "bottom" | "left" | "right";
  };

export const TooltipIconButton = forwardRef<
  HTMLButtonElement,
  TooltipIconButtonProps
>(({ children, tooltip, side = "bottom", className, ...rest }, ref) => {
  return (
    <Tooltip label={tooltip} position={side}>
      <ActionIcon
        {...rest}
        variant="transparent"
        className={cx("aui-button-icon", styles.root, className)}
        ref={ref}
      >
        {children}
        <span className={cx("aui-sr-only", a11y.srOnly)}>{tooltip}</span>
      </ActionIcon>
    </Tooltip>
  );
});

TooltipIconButton.displayName = "TooltipIconButton";
