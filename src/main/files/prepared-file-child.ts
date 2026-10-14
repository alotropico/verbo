import { AsyncLocalStorage } from "node:async_hooks";
import type { ActionResult } from "../../shared/action-contract";
import type { MutationSubmit } from "./mutation-plan";

type PreparedChild = Pick<
  MutationSubmit,
  "database" | "actor" | "threadId" | "turnId" | "action" | "args"
> & {
  execute: () => ActionResult;
  consumed: boolean;
};
const prepared = new AsyncLocalStorage<PreparedChild>();
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : item,
  );
}

/** This grant exists only inside trusted backend dispatch; it is never serialized. */
export async function dispatchPreparedFileChild(
  input: Omit<PreparedChild, "consumed">,
  dispatch: () => Promise<ActionResult>,
): Promise<ActionResult> {
  return prepared.run({ ...input, consumed: false }, dispatch);
}
export function consumePreparedFileChild(
  input: MutationSubmit,
): ActionResult | undefined {
  const grant = prepared.getStore();
  if (!grant) return undefined;
  if (
    grant.consumed ||
    grant.database !== input.database ||
    grant.actor !== input.actor ||
    grant.threadId !== input.threadId ||
    grant.turnId !== input.turnId ||
    grant.action !== input.action ||
    canonical(grant.args) !== canonical(input.args)
  ) {
    return {
      action: input.action,
      status: "error",
      code: "invalid_grant",
      summary: "The prepared child does not match the confirmed operation.",
    };
  }
  grant.consumed = true;
  return grant.execute();
}
