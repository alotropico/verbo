"use client";

import type { ComponentProps } from "react";
import { useRef, useState } from "react";
import { cx } from "@/lib/cx";
import { useIsomorphicLayoutEffect } from "./useIsomorphicLayoutEffect";
import styles from "./surfaces.module.css";

export const paper = styles.paper;

export const floating = styles.floating;

export const field = styles.field;

export const fieldInteractive = styles.fieldInteractive;

export const pressable = styles.pressable;

export const ghostButton = styles.ghostButton;

export const inkButton = styles.inkButton;

export const iconSwap = styles.iconSwap;

export const iconSwapIn = styles.iconSwapIn;

export const iconSwapOut = styles.iconSwapOut;

export const labelSwap = styles.labelSwap;

export const labelSwapIn = styles.labelSwapIn;

export const labelSwapOut = styles.labelSwapOut;

export const collapsePanel = styles.collapsePanel;

export const live = styles.live;

export const mono = styles.mono;

export function ShimmerLabel({
  active = true,
  className,
  ...props
}: ComponentProps<"span"> & { active?: boolean }) {
  return <span className={cx(active && "shimmer", className)} {...props} />;
}

/**
 * Scroll region for content that keeps its own whitespace. `whitespace-pre` in
 * a bounded box clips a long line with no way to reach it, so the rows scroll
 * instead.
 *
 * `codeSurface` wraps all the rows as one block, and the rows are its children.
 * It cannot go on each row: `min-width: 100%` resolves against the scroll
 * container's visible width rather than its scroll width, so a per-row width
 * leaves every row except the longest ending its background at the fold.
 */
export const codeScroll = styles.codeScroll;

export const codeSurface = styles.codeSurface;

export function SwapLabel({
  active,
  children,
  className,
}: {
  active: 0 | 1;
  children: [React.ReactNode, React.ReactNode];
  className?: string;
}) {
  const layers = [useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null)];
  const [width, setWidth] = useState<number | null>(null);

  useIsomorphicLayoutEffect(() => {
    const target = layers[active]?.current;
    if (!target) return undefined;
    const measure = () =>
      setWidth(Math.ceil(target.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [active]);

  return (
    <span
      style={width === null ? undefined : { width }}
      className={cx(styles.swapLabelGrid, className)}
    >
      {children.map((layer, index) => (
        <span
          key={index}
          ref={layers[index]}
          aria-hidden={active !== index}
          className={cx(
            labelSwap,
            active === index ? labelSwapIn : labelSwapOut,
          )}
        >
          {layer}
        </span>
      ))}
    </span>
  );
}
