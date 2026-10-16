import { describe, expect, it, vi } from "vitest";
import {
  constrainedDecision,
  globalDecisionSchema,
  localDecisionSchema,
} from "./decision";
describe("constrained decisions", () => {
  it("bounds invalid corrections and rejects arbitrary workflow IDs", async () => {
    const invoke = vi.fn(async () => ({
      kind: "new",
      workflowId: "arbitrary-module",
    }));
    await expect(
      constrainedDecision({ schema: globalDecisionSchema, invoke }),
    ).rejects.toThrow("one correction");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("keeps inability to classify distinct from the mutating choices", () => {
    const schema = localDecisionSchema([
      "write",
      "edit",
      "move",
      "rename",
      "delete",
    ]);
    expect(
      schema.safeParse({ kind: "selected", value: "unknown" }).success,
    ).toBe(false);
    expect(
      schema.parse({ kind: "cannot_classify", question: "What operation?" })
        .kind,
    ).toBe("cannot_classify");
  });
});
