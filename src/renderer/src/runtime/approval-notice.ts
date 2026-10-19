import { actionResultSchema } from "@shared/action-contract";
import { isPendingApprovalResult } from "@shared/tool-result-label";

const sentIds = new Set<string>();

export type ApprovalPart = {
  type: string;
  toolCallId?: string;
  result?: unknown;
  status?: { type?: string };
  approval?: {
    id?: string;
    prompt?: string;
    approved?: boolean;
    resolution?: string;
  };
};

export type ApprovalNotice = {
  id: string;
  body: string;
  result?: unknown;
};

export function resetApprovalNotices(): void {
  sentIds.clear();
}

export function approvalNoticeBody(summary: string | undefined): string {
  const text = summary?.replace(/\s+/g, " ").trim();
  if (!text) return "Verbo is waiting for your approval.";
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function unsettledApproval(part: ApprovalPart): boolean {
  const approval = part.approval;
  return (
    approval != null &&
    approval.approved === undefined &&
    approval.resolution === undefined
  );
}

/** Pending decisions stay out of tool and activity disclosures. */
export function approvalStaysOutsideGroups(part: ApprovalPart): boolean {
  if (part.type !== "tool-call") return false;
  return (
    part.status?.type === "requires-action" ||
    isPendingApprovalResult(part.result) ||
    unsettledApproval(part)
  );
}

export function describeApprovalRequest(
  part: ApprovalPart,
): ApprovalNotice | undefined {
  if (!approvalStaysOutsideGroups(part)) return undefined;
  const parsed = actionResultSchema.safeParse(part.result);
  const pending =
    parsed.success && parsed.data.status === "requires_confirmation";
  const id =
    (pending ? parsed.data.operationId : undefined) ??
    part.approval?.id ??
    part.toolCallId;
  if (!id) return undefined;
  return {
    id,
    body: approvalNoticeBody(
      pending ? parsed.data.summary : part.approval?.prompt,
    ),
    ...(pending ? { result: part.result } : {}),
  };
}

export function approvalRequestsFromParts(
  parts: readonly ApprovalPart[],
): ApprovalNotice[] {
  const requests: ApprovalNotice[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const request = describeApprovalRequest(part);
    if (!request || seen.has(request.id)) continue;
    seen.add(request.id);
    requests.push(request);
  }
  return requests;
}

export function notifyApprovalRequest(id: string, body: string): void {
  if (!id || sentIds.has(id)) return;
  sentIds.add(id);
  if (typeof Notification === "undefined") return;
  const title = "Approval needed";
  const options = { body: approvalNoticeBody(body) };
  const show = (): void => {
    try {
      const notice = new Notification(title, options);
      notice.onclick = () => {
        globalThis.focus();
        notice.close();
      };
    } catch {
      // The operating system can refuse a toast without failing the request UI.
    }
  };
  if (Notification.permission === "granted") {
    show();
    return;
  }
  if (
    Notification.permission === "denied" ||
    typeof Notification.requestPermission !== "function"
  ) {
    return;
  }
  void Notification.requestPermission().then((permission) => {
    if (permission === "granted") show();
  });
}
