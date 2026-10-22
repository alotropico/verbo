import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentId, WorkflowAttribution } from "../../shared/workflows";
import { stableCommandJson } from "../capabilities/preparation";
import type { ActionResult } from "../../shared/action-contract";

export type CapabilityGrant = {
  modules: readonly string[];
  actions: readonly string[];
};
export type InvocationPolicy = {
  id: string;
  agentId: AgentId;
  allowed: CapabilityGrant;
  discoverable: CapabilityGrant;
  exposed: boolean;
  forbidden: readonly string[];
  attribution?: WorkflowAttribution;
  ledger?: {
    before: (
      action: string,
      args: Record<string, unknown>,
      kind: "read" | "mutation",
    ) => { id: string; receiptId: string; replay?: ActionResult } | Promise<{ id: string; receiptId: string; replay?: ActionResult }>;
    after: (claim: { id: string; receiptId: string }, result: ActionResult) => void;
  };
};
const trusted = new WeakSet<InvocationPolicy>();
const current = new AsyncLocalStorage<InvocationPolicy>();
const boundChild = new AsyncLocalStorage<{ action: string; args: string }>();
const approvals = new Map<string, { policy: InvocationPolicy; threadId: string; expiresAt: number }>();

export function createInvocationPolicy(input: InvocationPolicy): InvocationPolicy {
  const policy = Object.freeze({
    ...input,
    allowed: Object.freeze({
      modules: Object.freeze([...input.allowed.modules]),
      actions: Object.freeze([...input.allowed.actions]),
    }),
    discoverable: Object.freeze({
      modules: Object.freeze([...input.discoverable.modules]),
      actions: Object.freeze([...input.discoverable.actions]),
    }),
    forbidden: Object.freeze([...input.forbidden]),
  });
  trusted.add(policy);
  return policy;
}
export function activeInvocation(): InvocationPolicy | undefined {
  return current.getStore();
}
export function withInvocation<T>(policy: InvocationPolicy | undefined, run: () => T): T {
  if (policy && !trusted.has(policy)) throw new Error("Untrusted invocation identity.");
  // Nested registries cannot replace the foreground invocation's authority.
  const inherited = current.getStore();
  return inherited ? run() : policy ? current.run(policy, run) : run();
}
function matches(grant: CapabilityGrant, action: string): boolean {
  return grant.actions.includes(action) || grant.modules.some((module) => action.startsWith(`${module}.`));
}
export function permitsCommand(action: string, discovery = false, args?: Record<string, unknown>): boolean {
  const policy = current.getStore();
  if (!policy) return true;
  if (!policy.exposed || policy.agentId !== "commander" || policy.forbidden.some((id) => action === id || action.startsWith(`${id}.`)))
    return false;
  const child = boundChild.getStore();
  return (
    matches(discovery ? policy.discoverable : policy.allowed, action) ||
    (!discovery && child?.action === action && args !== undefined && child.args === stableCommandJson(args))
  );
}
/** Only trusted, schema-bound composite/prepared children use this scope. No model/IPC entry point. */
export function withBoundCommand<T>(action: string, args: Record<string, unknown>, run: () => T): T {
  return boundChild.run({ action, args: stableCommandJson(args) }, run);
}
export function bindApprovalInvocation(operationId: string, threadId: string): void {
  const policy = current.getStore();
  if (!policy) return;
  for (const [id, binding] of approvals) if (binding.expiresAt < Date.now()) approvals.delete(id);
  approvals.set(operationId, {
    policy,
    threadId,
    expiresAt: Date.now() + 15 * 60_000,
  });
}
export function withApprovalInvocation<T>(operationId: string, threadId: string, run: () => T): T {
  const binding = approvals.get(operationId);
  if (binding && (binding.threadId !== threadId || binding.expiresAt < Date.now()))
    throw new Error("Approval invocation expired or belongs to another conversation.");
  return withInvocation(binding?.policy, run);
}
