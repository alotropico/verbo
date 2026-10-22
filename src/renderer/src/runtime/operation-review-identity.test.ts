import { describe, expect, it } from "vitest";
import type { ActionResult } from "@shared/action-contract";
import { operationReviewThreadId } from "./operation-review-identity";

const launch: ActionResult = {
  action: "software.launch",
  status: "requires_confirmation",
  summary: "Review 1 command.",
  operationId: "9de45259-8a1c-4ca8-abd3-7a5848e158ce",
  detailsAvailable: true,
};

describe("operation review chat identity", () => {
  it("uses the saved owning chat for a generic approval without file-specific detail", () => {
    expect(operationReviewThreadId(launch, "saved-chat")).toBe("saved-chat");
  });
  it("retains ordinary file approvals but cannot redirect review to another chat", () => {
    const file = { ...launch, action: "files.edit", detail: JSON.stringify({ threadId: "saved-chat" }) };
    expect(operationReviewThreadId(file, "saved-chat")).toBe("saved-chat");
    expect(operationReviewThreadId(file, "other-chat")).toBeNull();
    expect(operationReviewThreadId(file)).toBeNull();
    expect(operationReviewThreadId(launch, "pending")).toBeNull();
  });
});
