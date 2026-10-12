import { z } from "zod";
import { persistedThreadIdSchema } from "./thread-identity";

/** Managed copies stay out of chat JSON. Messages and queue rows store these refs. */
export const ATTACHMENT_LIMITS = {
  maxFileBytes: 8 * 1024 * 1024,
  maxStoreBytes: 64 * 1024 * 1024,
  maxPerThread: 32,
  maxPerTurn: 8,
  maxExtractChars: 8_000,
  maxNameChars: 180,
  maxPreviewBytes: 1_500_000,
  unreferencedTtlMs: 24 * 60 * 60 * 1000,
} as const;

export const attachmentRefSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(ATTACHMENT_LIMITS.maxNameChars),
    mediaType: z.string().trim().min(1).max(127),
  })
  .strict();

export const attachmentRefsSchema = z
  .array(attachmentRefSchema)
  .max(ATTACHMENT_LIMITS.maxPerTurn);

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

const base64Max = Math.ceil(ATTACHMENT_LIMITS.maxFileBytes / 3) * 4 + 8;

export const attachmentAddSchema = z
  .object({
    threadId: persistedThreadIdSchema,
    name: z.string().trim().min(1).max(ATTACHMENT_LIMITS.maxNameChars),
    mediaType: z.string().trim().min(1).max(127),
    bytesBase64: z.string().min(1).max(base64Max),
  })
  .strict();

export const attachmentIdSchema = z
  .object({
    threadId: persistedThreadIdSchema,
    id: z.string().uuid(),
  })
  .strict();

export const attachmentPreviewSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export type AttachmentAddResult =
  | { ok: true; attachment: AttachmentRef }
  | { ok: false; code: string; summary: string };

export type AttachmentPreview =
  | { ok: true; mediaType: string; dataUrl: string }
  | { ok: false; code: string; summary: string };

export function safeAttachmentName(name: string): string {
  const leaf = name.split(/[/\\]/u).pop()?.trim() ?? "";
  const cleaned = leaf.replace(/[^\w.\- ()[\]]+/gu, "_").slice(0, 180);
  return cleaned.length > 0 ? cleaned : "file";
}

const attachmentUuid = z.string().uuid();

export function isAttachmentId(value: string): boolean {
  return attachmentUuid.safeParse(value).success;
}

export function safeMediaType(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return /^[\w.+-]+\/[\w.+-]+$/u.test(trimmed)
    ? trimmed
    : "application/octet-stream";
}
