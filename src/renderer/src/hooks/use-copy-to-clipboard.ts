"use client";

import { useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";

export type UseCopyToClipboardOptions = {
  copiedDuration?: number;
};

export const useCopyToClipboard = ({
  copiedDuration = 3000,
}: UseCopyToClipboardOptions = {}): {
  isCopied: boolean;
  copyToClipboard: (value: string) => void;
} => {
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const scopeGenerationRef = useRef(0);

  useEffect(
    () => () => {
      scopeGenerationRef.current += 1;
      if (copiedTimerRef.current === undefined) return;

      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = undefined;
      setIsCopied(false);
    },
    [],
  );

  const copyToClipboard = (value: string): void => {
    if (!value) {
      return;
    }

    const scopeGeneration = scopeGenerationRef.current;
    copyText(value).then(
      (copied) => {
        if (!copied || scopeGeneration !== scopeGenerationRef.current) return;

        if (copiedTimerRef.current !== undefined) {
          clearTimeout(copiedTimerRef.current);
        }
        setIsCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          copiedTimerRef.current = undefined;
          setIsCopied(false);
        }, copiedDuration);
      },
      () => {},
    );
  };

  return { isCopied, copyToClipboard };
};
