import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approvalRequestsFromParts,
  approvalStaysOutsideGroups,
  notifyApprovalRequest,
  resetApprovalNotices,
} from "./approval-notice";

const pendingResult = {
  action: "files.move",
  status: "requires_confirmation",
  summary: "Move the note into Archive",
  operationId: "op-1",
};

afterEach(() => {
  resetApprovalNotices();
  vi.unstubAllGlobals();
});

describe("approval request placement", () => {
  it("keeps a pending confirmation out of grouped reports", () => {
    const part = {
      type: "tool-call",
      toolCallId: "call-1",
      result: pendingResult,
    };
    expect(approvalStaysOutsideGroups(part)).toBe(true);
    expect(approvalRequestsFromParts([part])).toEqual([
      {
        id: "op-1",
        body: "Move the note into Archive",
        result: pendingResult,
      },
    ]);
  });

  it("keeps an open interrupt out of grouped reports and ignores a settled one", () => {
    expect(
      approvalStaysOutsideGroups({
        type: "tool-call",
        toolCallId: "call-2",
        status: { type: "requires-action" },
      }),
    ).toBe(true);
    expect(
      approvalStaysOutsideGroups({
        type: "tool-call",
        toolCallId: "call-3",
        approval: { id: "approval-3", approved: true },
      }),
    ).toBe(false);
    expect(
      approvalRequestsFromParts([
        {
          type: "tool-call",
          toolCallId: "call-2",
          status: { type: "requires-action" },
          approval: { id: "approval-2", prompt: "Allow the rename?" },
        },
        { type: "text" },
      ]),
    ).toEqual([{ id: "approval-2", body: "Allow the rename?" }]);
  });

  it("shortens a long summary and reports one request per operation", () => {
    const summary = "Move ".repeat(80);
    const result = { ...pendingResult, summary };
    const requests = approvalRequestsFromParts([
      { type: "tool-call", toolCallId: "call-a", result },
      { type: "tool-call", toolCallId: "call-b", result },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.endsWith("...")).toBe(true);
    expect(requests[0]?.body.length).toBeLessThanOrEqual(180);
  });
});

describe("approval operating-system notification", () => {
  it("posts one toast per request and focuses the window when opened", () => {
    const created: { title: string; body?: string; onclick?: () => void }[] =
      [];
    const focus = vi.fn();
    vi.stubGlobal("focus", focus);
    class FakeNotification {
      static permission: NotificationPermission = "granted";
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(title: string, options?: NotificationOptions) {
        created.push({ title, body: options?.body, onclick: undefined });
        created[created.length - 1]!.onclick = () => this.onclick?.();
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    notifyApprovalRequest("op-1", "Move the note");
    notifyApprovalRequest("op-1", "Move the note again");
    expect(created).toEqual([
      {
        title: "Approval needed",
        body: "Move the note",
        onclick: expect.any(Function),
      },
    ]);
    created[0]?.onclick?.();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("requests permission once when it is still undecided", async () => {
    const created: string[] = [];
    const requestPermission = vi.fn(
      async () => "granted" as NotificationPermission,
    );
    class FakeNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = requestPermission;
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(_title: string, options?: NotificationOptions) {
        created.push(options?.body ?? "");
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    notifyApprovalRequest("op-2", "Rename the note");
    await vi.waitFor(() => expect(created).toEqual(["Rename the note"]));
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when notifications are denied or unavailable", () => {
    class DeniedNotification {
      static permission: NotificationPermission = "denied";
      static requestPermission = vi.fn();
      constructor() {
        throw new Error("should not construct");
      }
    }
    vi.stubGlobal("Notification", DeniedNotification);
    expect(() =>
      notifyApprovalRequest("op-3", "Delete the note"),
    ).not.toThrow();
    expect(DeniedNotification.requestPermission).not.toHaveBeenCalled();

    resetApprovalNotices();
    vi.stubGlobal("Notification", undefined);
    expect(() =>
      notifyApprovalRequest("op-4", "Delete the note"),
    ).not.toThrow();
  });
});
