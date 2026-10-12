import type { CreateAppendMessage } from "@assistant-ui/react";
import {
  safeAttachmentName,
  safeMediaType,
  type AttachmentAddResult,
  type AttachmentRef,
} from "@shared/attachments";

export function filePart(ref: AttachmentRef): {
  type: "file";
  data: string;
  sourceType: "id";
  filename: string;
  mimeType: string;
} {
  return {
    type: "file",
    data: ref.id,
    sourceType: "id",
    filename: ref.name,
    mimeType: ref.mediaType,
  };
}

export function appendUserTurn(
  text: string,
  refs: readonly AttachmentRef[],
): CreateAppendMessage {
  const content = [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...refs.map(filePart),
  ];
  if (content.length === 0) return text;
  return { role: "user", content, startRun: true };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export async function storeAttachmentFile(input: {
  threadId: string;
  file: File;
}): Promise<AttachmentAddResult> {
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  return window.verbo.attachments.add({
    threadId: input.threadId,
    name: safeAttachmentName(input.file.name || "file"),
    mediaType: safeMediaType(input.file.type || "application/octet-stream"),
    bytesBase64: bytesToBase64(bytes),
  });
}
