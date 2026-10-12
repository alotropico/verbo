"use client";

import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";

const useFileSrc = (file: File | undefined): string | undefined => {
  const [entry, setEntry] = useState<{ file: File; url: string } | undefined>(
    undefined,
  );

  useEffect(() => {
    // The object URL is a browser resource whose lifetime has to straddle
    // commit, so allocation, revocation, and clearing the entry that names a
    // revoked URL all belong to the effect.
    if (!file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEntry(undefined);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setEntry({ file, url: objectUrl });

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return entry !== undefined && entry.file === file ? entry.url : undefined;
};

export const useAttachmentSrc = (): string | undefined => {
  const { file, src, attachmentId } = useAuiState(
    useShallow((s): { file?: File; src?: string; attachmentId?: string } => {
      if (s.attachment.type !== "image") return {};
      if (s.attachment.file) return { file: s.attachment.file };
      const image = s.attachment.content?.filter((c) => c.type === "image")[0]
        ?.image;
      if (image) return { src: image };
      const stored = s.attachment.content?.find(
        (part) =>
          part.type === "file" &&
          part.sourceType === "id" &&
          part.mimeType.startsWith("image/"),
      );
      if (stored?.type === "file") return { attachmentId: stored.data };
      return {};
    }),
  );
  const [preview, setPreview] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!attachmentId) return undefined;
    let cancelled = false;
    void window.verbo.attachments.preview(attachmentId).then((result) => {
      if (!cancelled && result.ok) setPreview(result.dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [attachmentId]);

  return useFileSrc(file) ?? src ?? (attachmentId ? preview : undefined);
};
