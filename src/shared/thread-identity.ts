import { z } from "zod";

export const persistedThreadIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((id) => id !== "active" && id !== "pending", {
    message: "Thread id must already be persisted.",
  });

export const branchAnchorSchema = persistedThreadIdSchema;

export function isPersistedThreadId(id: string | undefined): id is string {
  return persistedThreadIdSchema.safeParse(id).success;
}

/** A new chat's local id is not a database row until initialize runs. */
export function savedRemoteThreadId(
  item:
    | {
        status: string;
        remoteId: string | undefined;
      }
    | undefined,
): string | null {
  if (!item || item.status === "new") return null;
  if (!isPersistedThreadId(item.remoteId)) return null;
  return item.remoteId;
}
