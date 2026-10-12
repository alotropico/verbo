import {
  type AttachmentAdapter,
  type CompleteAttachment,
  type PendingAttachment,
} from "@assistant-ui/react";
import { safeMediaType } from "@shared/attachments";
import { filePart, storeAttachmentFile } from "./attachment-message";

const ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,image/bmp,.pdf,.txt,.md,.markdown,.json,.csv,.yaml,.yml,text/plain,application/pdf,application/json";

function attachmentType(file: File): "image" | "document" | "file" {
  if (file.type.startsWith("image/")) return "image";
  if (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  ) {
    return "document";
  }
  return "file";
}

export function createVerboAttachmentAdapter(
  threadId: () => string | null,
): AttachmentAdapter {
  return {
    accept: ACCEPT,
    async add({ file }) {
      const pending: PendingAttachment = {
        id: crypto.randomUUID(),
        type: attachmentType(file),
        name: file.name || "file",
        contentType: safeMediaType(file.type || "application/octet-stream"),
        file,
        status: { type: "requires-action", reason: "composer-send" },
      };
      return pending;
    },
    async send(attachment) {
      const id = threadId();
      if (!id)
        throw new Error("Save the conversation before attaching a file.");
      const saved = await storeAttachmentFile({
        threadId: id,
        file: attachment.file,
      });
      if (!saved.ok) throw new Error(saved.summary);
      const complete: CompleteAttachment = {
        id: saved.attachment.id,
        type: attachment.type,
        name: saved.attachment.name,
        contentType: saved.attachment.mediaType,
        status: { type: "complete" },
        content: [filePart(saved.attachment)],
      };
      return complete;
    },
    async remove(attachment) {
      const id = threadId();
      if (!id || attachment.status.type !== "complete") return;
      await window.verbo.attachments.remove({
        threadId: id,
        id: attachment.id,
      });
    },
  };
}
