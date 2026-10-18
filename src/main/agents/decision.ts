import { z } from "zod";
import { workflowIdSchema } from "../../shared/workflows";

export const globalDecisionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("new"),
      workflowId: workflowIdSchema,
      targetHint: z.string().max(200).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resume"),
      executionId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
      answer: z.union([z.boolean(), z.string().max(8000)]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["suspend", "cancel"]),
      executionId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("clarify"),
      question: z.string().min(1).max(2000),
    })
    .strict(),
]);
export type GlobalDecision = z.infer<typeof globalDecisionSchema>;

export const GLOBAL_DECISION_INSTRUCTIONS = `Choose a listed workflow or pending-execution disposition from compact trusted cards.
Use conversational for explanation/discussion/standalone writing without external action, commander for generic operations, obsidian for requested note/vault operations.
An app mention in an explanatory question is conversational. Configured folder aliases/descriptions identify implicit destinations.
If the destination is ambiguous, clarify; do not select the first listed vault or substitute a generic default.
Listed directories are locations inside that folder, not separate destinations. A path or name that matches one listed directory selects that parent folder; copy its alias as targetHint. Do not ask the user to choose between a configured folder and one of its directories.
When exactly one configured vault is available, choose obsidian for a vault operation without asking which vault. If the request names a listed vault alias (for example garden:/note.md), choose obsidian and copy that exact alias as targetHint.
Your job is route selection. Missing note paths, source content, edit instructions or other action parameters belong to the selected workflow; they are not reasons to ask a global routing question.
Selecting kind=new only selects a workflow; it does not execute anything and needs no permission question.
Examples with one vault alias garden and project folder work:
"Hello" -> {"kind":"new","workflowId":"conversational"}
"Explain what Obsidian is" -> {"kind":"new","workflowId":"conversational"}
"Write a poem about a garden" -> {"kind":"new","workflowId":"conversational"}
"Create an Obsidian note" -> {"kind":"new","workflowId":"obsidian","targetHint":"garden"}
"Rename garden:/idea.md" -> {"kind":"new","workflowId":"obsidian","targetHint":"garden"}
"List PDFs in work" -> {"kind":"new","workflowId":"commander","targetHint":"work"}
"Move files in Desktop/agent-files, where agent-files is a directory of desktop" -> {"kind":"new","workflowId":"commander","targetHint":"desktop"}
"Search the web for documentation" -> {"kind":"new","workflowId":"commander"}
"Open the registered project Verbo" -> {"kind":"new","workflowId":"commander"}
"Use the registered environment.platform command" -> {"kind":"new","workflowId":"commander"}
"Create fixture:/note.md" in a normal folder -> {"kind":"new","workflowId":"commander","targetHint":"fixture"}
"Create work:/summary.txt describing my garden vault" -> {"kind":"new","workflowId":"commander","targetHint":"work"}
A generic note or filename in a normal/project folder is commander. The word note does not make a folder an Obsidian vault; only folders with kind=obsidian are vaults.
With several unnamed vaults, "save a note in a vault" -> {"kind":"clarify","question":"Which vault should I use?"}
Use resume only for a relevant later answer or explicit resume reference to a listed pending execution, copying its exact ID/revision. A queued interruption is always a new request, even 'yes'.
Never choose an unlisted execution, fabricate a target or emit commands. Return only the requested JSON.`;

/** One initial sample and at most one correction, both charged to the shared turn budget. */
export async function constrainedDecision<T>(input: {
  schema: z.ZodType<T>;
  invoke: (correction?: string) => Promise<unknown>;
}): Promise<{ value: T; corrections: number }> {
  let last = "Invalid decision output.";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await input.invoke(
        attempt
          ? `Correct the decision contract only. ${last.slice(0, 500)}`
          : undefined,
      );
      return { value: input.schema.parse(raw), corrections: attempt };
    } catch (error) {
      last =
        error instanceof Error ? error.message : "Invalid decision output.";
    }
  }
  throw new Error(
    `Decision could not be classified after one correction: ${last.slice(0, 500)}`,
  );
}

export function localDecisionSchema(
  choices: readonly (string | boolean)[],
): z.ZodType<
  | { kind: "selected"; value: string | boolean }
  | { kind: "cannot_classify"; question: string }
> {
  return z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("selected"),
        value: z.union(choices.map((value) => z.literal(value))),
      })
      .strict(),
    z
      .object({
        kind: z.literal("cannot_classify"),
        question: z.string().min(1).max(2000),
      })
      .strict(),
  ]);
}
