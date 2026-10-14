"use client";

import { useAuiState } from "@assistant-ui/react";
import { revealTextPrefix } from "@shared/speech-reveal";
import { useMemo, type ReactElement } from "react";

import { useVoiceSession } from "@/components/voice-session-context";
import { cx } from "@/lib/cx";

import { MarkdownText } from "./markdown-text";
import styles from "./thread.module.css";

type SpeechReveal =
  { mode: "full" } | { mode: "hidden" } | { mode: "partial"; ratio: number };

function useSpeechReveal(): SpeechReveal {
  const messageId = useAuiState((state) => state.message.id);
  const role = useAuiState((state) => state.message.role);
  const running = useAuiState(
    (state) => state.message.status?.type === "running",
  );
  const session = useVoiceSession();
  const caption = session?.speechCaption ?? null;
  const willSpeak =
    role === "assistant" && session?.active === true && session.muted === false;
  if (!willSpeak) return { mode: "full" };
  if (running) return { mode: "hidden" };
  if (caption && caption.messageId === messageId) {
    return { mode: "partial", ratio: caption.ratio };
  }
  return { mode: "full" };
}

function SpeechPending(): ReactElement {
  return (
    <span
      className={styles.typingDots}
      role="status"
      aria-label="Preparing speech"
    >
      <span className={styles.typingDot} />
      <span className={cx(styles.typingDot, styles.typingDotSecond)} />
      <span className={cx(styles.typingDot, styles.typingDotThird)} />
    </span>
  );
}

export function SpeechSyncedText({
  plain = false,
}: {
  plain?: boolean;
}): ReactElement | null {
  const text = useAuiState((state) =>
    state.part.type === "text" ? state.part.text : "",
  );
  const reveal = useSpeechReveal();
  const ratio = reveal.mode === "partial" ? reveal.ratio : 1;
  const preprocess = useMemo(
    () =>
      reveal.mode === "partial"
        ? (value: string) => revealTextPrefix(value, ratio)
        : undefined,
    [ratio, reveal.mode],
  );

  if (reveal.mode === "hidden") return null;
  const shown =
    reveal.mode === "partial" ? revealTextPrefix(text, ratio) : text;
  if (reveal.mode === "partial" && shown.length === 0) return <SpeechPending />;
  if (plain) return <p className={styles.spokenText}>{shown}</p>;
  return (
    <MarkdownText defer={reveal.mode !== "partial"} preprocess={preprocess} />
  );
}
