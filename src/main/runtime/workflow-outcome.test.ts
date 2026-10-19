import { describe, expect, it } from "vitest";
import {
  verifiedOutcomeSchema,
  type VerifiedOutcome,
} from "../../shared/workflows";
import {
  deterministicPresentation,
  readableReportInput,
  validatePresentation,
} from "./workflow-outcome";

const receiptId = "00000000-0000-4000-8000-000000000002";

function outcome(): VerifiedOutcome {
  return verifiedOutcomeSchema.parse({
    version: 1,
    executionId: "00000000-0000-4000-8000-000000000001",
    workflowId: "commander",
    status: "partial",
    requestMessageId: "user-1",
    findings: [
      "A folder selection can change at most 100 files. This one is larger, so nothing changed.",
      "Listed 15 entries. More remain.",
    ],
    receiptIds: [receiptId],
    uncertainReceiptIds: [],
    errors: [
      {
        code: "no_progress",
        summary: "The same tool request was repeated without new work.",
      },
    ],
  });
}

describe("workflow presentation", () => {
  it("keeps a composed reply and rejects an invented receipt id", () => {
    const frozen = outcome();
    expect(
      validatePresentation(frozen, {
        text: "The folder was too large to change, so nothing was updated. The listing showed 15 entries and more remain. A repeated request added no further work.",
      }),
    ).toMatch(/folder was too large/);
    expect(
      validatePresentation(frozen, {
        text: `See receipt ${receiptId} for the list.`,
      }),
    ).toBeUndefined();
    expect(
      validatePresentation(frozen, {
        text: "See receipt 11111111-1111-4111-8111-111111111111.",
      }),
    ).toBeUndefined();
    expect(validatePresentation(frozen, { text: "  " })).toBeUndefined();
    const questioned = {
      ...frozen,
      question: {
        text: "Which folder should be used?",
        required: true as const,
        expected: { type: "text" as const, maxLength: 200 },
        binding: "folder",
      },
    };
    expect(readableReportInput(questioned).question).toBe(
      "Which folder should be used?",
    );
    expect(JSON.stringify(readableReportInput(questioned))).not.toContain(
      receiptId,
    );
    expect(
      validatePresentation(questioned, {
        text: "The folder was too large. Which folder should be used?",
      }),
    ).toMatch(/Which folder/);
    expect(
      validatePresentation(questioned, {
        text: "The folder was too large.",
      }),
    ).toBeUndefined();
    expect(validatePresentation(frozen, { sentences: [] })).toBeUndefined();
  });

  it("still stitches the frozen outcome when presentation is unavailable", () => {
    expect(deterministicPresentation(outcome())).toBe(
      [
        "Some work completed; the remaining work needs attention.",
        "A folder selection can change at most 100 files. This one is larger, so nothing changed.",
        "Listed 15 entries. More remain.",
        "The same tool request was repeated without new work.",
      ].join("\n\n"),
    );
  });
});
