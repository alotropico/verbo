import { actionResultSchema } from "./action-contract";

export function isPendingApprovalResult(value: unknown): boolean {
  const parsed = actionResultSchema.safeParse(value);
  return parsed.success && parsed.data.status === "requires_confirmation";
}

export function toolResultLabel(value: unknown): string | undefined {
  const parsed = actionResultSchema.safeParse(value);
  if (!parsed.success) return;
  const result = parsed.data;
  if (result.code === "effect_uncertain" || result.code === "receipt_failed")
    return "Uncertain";
  if (result.code === "unattempted") return "Not attempted";
  if (result.code === "duplicate_feedback") return "Previous result";
  if (result.status === "requires_confirmation") return "Awaiting approval";
  if (result.status === "cancelled") return "Stopped";
  if (
    result.status === "error" ||
    result.status === "denied" ||
    result.status === "not_supported"
  )
    return "Blocked";
  if (result.status === "partial") return "Partially completed";
  return "Completed";
}
