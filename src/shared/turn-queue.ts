import { z } from "zod";
import { attachmentRefsSchema, type AttachmentRef } from "./attachments";
import { persistedThreadIdSchema } from "./thread-identity";

export const QUEUE_SOURCES = ["typed", "voice"] as const;

export const QUEUE_STATUSES = [
  "queued",
  "editing",
  "running",
  "awaiting_approval",
  "failed",
  "interrupted",
  "pinned",
  "completed",
  "cancelled",
] as const;

export type QueueSource = (typeof QUEUE_SOURCES)[number];
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export type QueuedTurn = {
  id: string;
  threadId: string;
  branchAnchor: string | null;
  source: QueueSource;
  text: string;
  attachmentRefs: AttachmentRef[];
  status: QueueStatus;
  sequence: number;
  revision: number;
  editToken: string | null;
  released: boolean;
  turnId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type QueueSnapshot = {
  items: QueuedTurn[];
  outgoingId: string | null;
  hold: boolean;
  waitingForThreadId: string | null;
  serviceHold: string | null;
};

export type QueueEditResult =
  | {
      ok: true;
      item: QueuedTurn;
      composerText: string;
      composerRefs: AttachmentRef[];
    }
  | { ok: false; summary: string };

export type QueueEnqueueResult =
  | { ok: true; item: QueuedTurn; start: boolean }
  | { ok: false; summary: string };

export type QueueClaimResult = {
  item: QueuedTurn | null;
  hold: boolean;
  waitingForThreadId: string | null;
};

export type QueueMutationResult =
  | {
      ok: true;
      summary: string;
      composerText?: string;
      composerRefs?: AttachmentRef[];
    }
  | { ok: false; summary: string };

const queueIdSchema = z.string().uuid();

export const queueEnqueueSchema = z
  .object({
    threadId: persistedThreadIdSchema,
    text: z.string().trim().min(1).max(500_000),
    branchAnchor: z.string().min(1).max(200).nullable(),
    source: z.enum(QUEUE_SOURCES).default("typed"),
    attachmentRefs: attachmentRefsSchema.default([]),
  })
  .strict();

export const queueThreadSchema = z
  .object({
    threadId: persistedThreadIdSchema,
  })
  .strict();

export const queueItemSchema = z
  .object({
    id: queueIdSchema,
  })
  .strict();

export const queueEditBeginSchema = z
  .object({
    id: queueIdSchema,
    threadId: persistedThreadIdSchema,
    revision: z.number().int().nonnegative(),
    composerText: z.string().max(500_000),
    composerRefs: attachmentRefsSchema.default([]),
  })
  .strict();

export const queueEditSaveSchema = z
  .object({
    id: queueIdSchema,
    threadId: persistedThreadIdSchema,
    revision: z.number().int().nonnegative(),
    token: z.string().min(1).max(80),
    text: z.string().trim().min(1).max(500_000),
    attachmentRefs: attachmentRefsSchema.default([]),
  })
  .strict();

export const queueEditCancelSchema = z
  .object({
    id: queueIdSchema,
    threadId: persistedThreadIdSchema,
    token: z.string().min(1).max(80),
  })
  .strict();

export const queueReorderSchema = z
  .object({
    id: queueIdSchema,
    threadId: persistedThreadIdSchema,
    revision: z.number().int().nonnegative(),
    direction: z.enum(["up", "down"]),
  })
  .strict();
