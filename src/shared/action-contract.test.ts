import { describe, expect, it } from "vitest";
import { actionRequestSchema, approvalReviewSchema } from "./action-contract";
import { persistedThreadIdSchema } from "./thread-identity";

describe("action contracts", () => {
  it("rejects actor and approved claims on action and review payloads", () => {
    expect(
      actionRequestSchema.safeParse({
        name: "files.list",
        threadId: "thread-1",
        approved: true,
      }).success,
    ).toBe(false);
    expect(
      actionRequestSchema.safeParse({
        name: "files.list",
        threadId: "thread-1",
        actor: "user_command",
      }).success,
    ).toBe(false);
    expect(
      approvalReviewSchema.safeParse({
        operationId: "op-1",
        threadId: "thread-1",
        approved: true,
      }).success,
    ).toBe(false);
  });

  it("rejects placeholder thread ids", () => {
    expect(persistedThreadIdSchema.safeParse("active").success).toBe(false);
    expect(persistedThreadIdSchema.safeParse("pending").success).toBe(false);
    expect(persistedThreadIdSchema.safeParse("thread-notes").success).toBe(
      true,
    );
  });
});
