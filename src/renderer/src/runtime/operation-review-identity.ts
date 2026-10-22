import type { ActionResult } from "@shared/action-contract";
import { isPersistedThreadId } from "@shared/thread-identity";

/** The runtime owns the chat identity; receipt detail cannot grant another owner. */
export function operationReviewThreadId(action: ActionResult, ownerThreadId?: string | null): string | null {
  if (!isPersistedThreadId(ownerThreadId ?? undefined)) return null;
  try {
    const detail: unknown = JSON.parse(action.detail ?? "null");
    if (
      detail &&
      typeof detail === "object" &&
      "threadId" in detail &&
      typeof detail.threadId === "string" &&
      detail.threadId !== ownerThreadId
    )
      return null;
  } catch {
    /* Stored plan review remains authoritative; malformed detail supplies no identity. */
  }
  return ownerThreadId ?? null;
}
