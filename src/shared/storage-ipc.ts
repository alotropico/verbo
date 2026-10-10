import { z } from "zod";
import { IPC_CHANNELS } from "./ipc-channels";
import { persistedThreadIdSchema } from "./thread-identity";

export { IPC_CHANNELS };

export const threadIdSchema = persistedThreadIdSchema;
export const titleSchema = z.string().min(1).max(200);

export const chatSettingsSchema = z.object({
  model: z.string().min(1).max(128),
  think: z.boolean(),
  temperature: z.number().min(0).max(2),
  numCtx: z.number().int().min(512).max(131072),
  keepAlive: z.string().min(1).max(32),
});

export const remoteThreadMetadataSchema = z.object({
  status: z.enum(["regular", "archived"]),
  remoteId: z.string(),
  externalId: z.string().optional(),
  title: z.string().optional(),
});

export type RemoteThreadMetadata = z.infer<typeof remoteThreadMetadataSchema>;

export const messageAppendSchema = z.object({
  threadId: threadIdSchema,
  parentId: z.string().optional(),
  message: z.unknown(),
});

export const welcomeLineSchema = z.object({
  verb: z.string().trim().min(1).max(40),
  modifier: z.string().trim().min(1).max(80),
});

export type WelcomeLineRequest = z.infer<typeof welcomeLineSchema>;

export const generateTitleSchema = z.object({
  threadId: threadIdSchema,
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .max(6),
});
