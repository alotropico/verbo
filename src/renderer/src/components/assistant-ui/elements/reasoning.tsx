"use client";

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useIsomorphicLayoutEffect } from "./useIsomorphicLayoutEffect";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { cx } from "@/lib/cx";
import styles from "./reasoning.module.css";
import {
  CollapsibleRoot as Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible-root";

export const ANIMATION_DURATION = 200;

const ReasoningPreviewContext = createContext(false);

export type ReasoningVariant = "outline" | "ghost" | "muted";

function reasoningVariants({
  className,
}: {
  variant?: ReasoningVariant;
  className?: string;
} = {}) {
  return cx("aui-reasoning-root", styles.root, className);
}

export type ReasoningRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  variant?: ReasoningVariant;
} & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  /**
   * Whether the reasoning is currently streaming. While `true` the
   * disclosure is held open with a bottom-pinned live preview; when
   * streaming ends it returns to `defaultOpen`, and the first manual
   * toggle takes over the open/close state permanently. The live preview
   * keeps following the newest tokens while the disclosure is open during
   * streaming, even after a manual toggle, and pauses while the reader is
   * scrolled up.
   */
  streaming?: boolean;
  /** Called right before the disclosure animates, on toggle and on streaming transitions. */
  onAnimationStart?: () => void;
};

const ReasoningRoot = forwardRef<
  HTMLDivElement,
  Omit<ReasoningRootProps, "ref">
>(function ReasoningRoot(
  {
    className,
    variant,
    open: controlledOpen,
    onOpenChange: controlledOnOpenChange,
    defaultOpen = false,
    streaming,
    onAnimationStart,
    children,
    ...props
  },
  ref,
) {
  const [initialOpen] = useState(defaultOpen);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled
    ? controlledOpen
    : (userOpen ?? (streaming || initialOpen));
  const isPreview = streaming === true && isOpen;

  const prevStreamingRef = useRef(streaming);
  useIsomorphicLayoutEffect(() => {
    if (prevStreamingRef.current === streaming) return;
    prevStreamingRef.current = streaming;
    // A streaming transition only animates the panel when the resting state
    // is collapsed; with `defaultOpen` the disclosure stays open across it.
    if (!isControlled && userOpen === null && !initialOpen) {
      onAnimationStart?.();
    }
  }, [streaming, isControlled, userOpen, initialOpen, onAnimationStart]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      onAnimationStart?.();
      if (!isControlled) {
        setUserOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [onAnimationStart, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={ref}
      data-slot="reasoning-root"
      data-variant={variant}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={reasoningVariants({
        variant,
        className: typeof className === "string" ? className : undefined,
      })}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      <ReasoningPreviewContext.Provider value={isPreview}>
        {children}
      </ReasoningPreviewContext.Provider>
    </Collapsible>
  );
});

function ReasoningFade({
  side = "bottom",
  className,
  ...props
}: React.ComponentProps<"div"> & { side?: "top" | "bottom" }) {
  if (side === "top") {
    return (
      <div
        data-slot="reasoning-fade"
        className={cx("aui-reasoning-fade", styles.fadeTop, className)}
        {...props}
      />
    );
  }

  return (
    <div
      data-slot="reasoning-fade"
      className={cx("aui-reasoning-fade", styles.fadeBottom, className)}
      {...props}
    />
  );
}

function ReasoningTrigger({
  active,
  duration,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  active?: boolean;
  duration?: number | undefined;
}) {
  const durationText = duration ? ` (${duration}s)` : "";

  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      className={cx("aui-reasoning-trigger", styles.trigger, className)}
      {...props}
    >
      <BrainIcon
        data-slot="reasoning-trigger-icon"
        className={cx("aui-reasoning-trigger-icon", styles.triggerIcon)}
      />
      <span
        data-slot="reasoning-trigger-label"
        className={cx(
          "aui-reasoning-trigger-label-wrapper",
          styles.triggerLabel,
          active && "shimmer",
        )}
      >
        Reasoning{durationText}
      </span>
      <ChevronDownIcon
        data-slot="reasoning-trigger-chevron"
        className={cx(
          "aui-reasoning-trigger-chevron",
          styles.triggerChevron,
          styles.chevron,
        )}
      />
    </CollapsibleTrigger>
  );
}

function ReasoningContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  const isPreview = useContext(ReasoningPreviewContext);

  return (
    <CollapsibleContent
      data-slot="reasoning-content"
      className={cx("aui-reasoning-content", styles.content, className)}
      {...props}
    >
      <ReasoningFade side="top" />
      {children}
      {isPreview ? <ReasoningFade /> : null}
    </CollapsibleContent>
  );
}

function ReasoningText({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const isPreview = useContext(ReasoningPreviewContext);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isPreview) return;
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return;

    let pinned = true;
    let lastScrollTop = scrollEl.scrollTop;
    let lastScrollHeight = scrollEl.scrollHeight;
    const isAtBottom = () =>
      Math.abs(
        scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight,
      ) <= 1 || scrollEl.scrollHeight <= scrollEl.clientHeight;

    const pin = () => {
      if (!pinned) return;
      scrollEl.scrollTop = scrollEl.scrollHeight;
    };
    // A pin's own scroll event can arrive after new content grew the scroll
    // height and read as "not at bottom"; only an upward move at unchanged
    // scroll height is user intent.
    const onScroll = () => {
      if (isAtBottom()) {
        pinned = true;
      } else if (
        scrollEl.scrollTop < lastScrollTop &&
        scrollEl.scrollHeight === lastScrollHeight
      ) {
        pinned = false;
      }
      lastScrollTop = scrollEl.scrollTop;
      lastScrollHeight = scrollEl.scrollHeight;
    };

    pin();
    scrollEl.addEventListener("scroll", onScroll);
    const observer = new ResizeObserver(pin);
    observer.observe(contentEl);
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [isPreview]);

  return (
    <div
      ref={scrollRef}
      data-slot="reasoning-text"
      className={cx("aui-reasoning-text", styles.text, className)}
      {...props}
    >
      <div
        ref={contentRef}
        className={cx("aui-reasoning-text-content", styles.textContent)}
      >
        {children}
      </div>
    </div>
  );
}

export {
  ReasoningRoot,
  ReasoningTrigger,
  ReasoningContent,
  ReasoningText,
  ReasoningFade,
  reasoningVariants,
};
