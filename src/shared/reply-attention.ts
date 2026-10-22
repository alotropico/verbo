import type { ChatEvent } from "./chat-ipc";
import { emptyChatProjection, projectChatEvent } from "./chat-projection";

/** Priority when several unread replies coexist. */
export const replyAttentionStates = ["question", "error", "partial", "success"] as const;
export type ReplyAttention = (typeof replyAttentionStates)[number];

export function replyAttention(events: readonly ChatEvent[]): ReplyAttention | undefined {
  const stop = events.findLast((event) => event.type === "turn_status");
  const saving = events.findLast((event) => event.type === "finalization");
  if (stop?.stop === "failed" || stop?.stop === "cancelled" || saving?.state === "failed" || events.some((event) => event.type === "error"))
    return "error";
  const results = new Map<string, Extract<ChatEvent, { type: "tool_result" | "approval" }>>();
  for (const event of events) {
    if (event.type === "approval" || event.type === "tool_result") results.set(event.toolCallId, event);
  }
  const execution = events.findLast((event) => event.type === "execution");
  if (
    events.some((event) => event.type === "input_required") ||
    execution?.execution.status === "awaiting_input" ||
    stop?.stop === "paused" ||
    [...results.values()].some((event) => event.result.status === "requires_confirmation")
  )
    return "question";
  if (!events.some((event) => event.type === "done")) return;
  if (!stop) return;
  // Reuse the verified trace that drives the reply's execution report.
  let projection = emptyChatProjection();
  for (const event of events) {
    if (event.type !== "delta") projection = projectChatEvent(projection, event);
  }
  const root = projection.trace?.nodes.findLast((node) => node.kind === "workflow" && !node.superseded);
  if (root?.outcome === "partial" || root?.outcome === "uncertain") return "partial";
  if (
    execution?.execution.status === "failed" ||
    execution?.execution.status === "cancelled" ||
    root?.outcome === "failed" ||
    root?.outcome === "cancelled" ||
    root?.outcome === "blocked"
  )
    return "error";
  if (stop && ["limit", "capacity", "no_progress"].includes(stop.stop)) return "partial";
  if (root?.outcome === "succeeded") return "success";
  const outcomes = [...results.values()].map((event) => event.result.status);
  if (outcomes.includes("partial")) return "partial";
  if (outcomes.some((status) => status !== "success")) return outcomes.includes("success") ? "partial" : "error";
  return "success";
}
