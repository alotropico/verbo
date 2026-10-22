import { z } from "zod";
import { actionResultSchema, type ActionResult } from "../../shared/action-contract";

type BranchMessage = { message: { id: string; role: string; content: unknown } };
const commandPart = z.object({
  type: z.literal("tool-call"),
  toolName: z.literal("actions.invoke"),
  result: actionResultSchema,
});

/** Context only: Alo still validates receipt ownership and every requested effect. */
export function priorCommandContext(branch: BranchMessage[]): { messageId: string; result: ActionResult }[] {
  return branch
    .slice(-4)
    .flatMap(({ message }) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
      return message.content.flatMap((part: unknown) => {
        const parsed = commandPart.safeParse(part);
        if (!parsed.success || !parsed.data.result.receiptId) return [];
        const result = parsed.data.result;
        return [{ messageId: message.id, result: { ...result, ...(result.detail ? { detail: result.detail.slice(0, 2000) } : {}) } }];
      });
    })
    .slice(-4);
}
