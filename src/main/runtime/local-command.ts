import type { ActionResult } from "../../shared/action-contract";
import {
  LOCAL_COMMANDS,
  parseLocalCommand,
  routeUtterance,
  type LocalCommandResult,
} from "../../shared/local-commands";
import { memoryTextSchema } from "../../shared/memory";
import type { CapabilityRegistry } from "../capabilities/registry";
import type { MemoryStore } from "../db/memory";

function presentAction(result: ActionResult): LocalCommandResult {
  const handled =
    result.status === "success" ||
    result.status === "partial" ||
    result.status === "requires_confirmation";
  const summary = result.detail
    ? `${result.summary}\n${result.detail}`
    : result.summary;
  return { status: handled ? "success" : "error", summary };
}

function helpText(registry: CapabilityRegistry): string {
  return LOCAL_COMMANDS.map((command) => {
    if (!command.actionId) return `${command.syntax} — ${command.blurb}`;
    const described = registry.describe([command.actionId]).entries[0];
    const detail = described?.description ?? command.blurb;
    return `${command.syntax} — ${command.actionId}. ${detail}`;
  }).join("\n");
}

function catalogText(registry: CapabilityRegistry): string {
  const root = registry.list();
  const lines = ["Registered capabilities:"];
  for (const category of root.children) {
    const listed = registry.list(category.id);
    for (const child of listed.children) {
      lines.push(`${child.id} — ${child.description}`);
    }
  }
  return lines.join("\n");
}

export function executeLocalCommand(input: {
  text: string;
  source?: "typed" | "voice";
  threadId?: string;
  store: MemoryStore;
  registry: CapabilityRegistry;
}): LocalCommandResult {
  const route = routeUtterance(input.text, input.source ?? "typed");
  if (route.kind === "new-chat") {
    return {
      status: "success",
      summary: "Opened a blank conversation. Stored chats stay in the list.",
      newThread: true,
    };
  }
  if (route.kind === "model") {
    return { status: "error", summary: "That text is not a local command." };
  }
  const parsed = parseLocalCommand(input.text);
  if (!parsed.handled) {
    return { status: "error", summary: "That text is not a local command." };
  }
  if (parsed.name === "malformed") {
    return { status: "error", summary: parsed.summary };
  }
  if (parsed.name === "help") {
    return { status: "success", summary: helpText(input.registry) };
  }
  if (parsed.name === "capabilities") {
    return { status: "success", summary: catalogText(input.registry) };
  }
  if (parsed.name === "memories") {
    return {
      status: "success",
      summary: "Opened memory settings.",
      openMemory: true,
    };
  }
  if (parsed.name === "remember") {
    const text = memoryTextSchema.safeParse(parsed.text);
    if (!text.success) {
      return {
        status: "error",
        summary: "Memory text is empty or too long.",
      };
    }
    const saved = input.store.add({
      text: text.data,
      scope: "global",
      inclusion: "always",
      actor: "user_command",
    });
    return saved.ok
      ? { status: "success", summary: saved.summary }
      : { status: "error", summary: saved.summary };
  }
  if (parsed.name === "files" || parsed.name === "action") {
    if (!input.threadId) {
      return {
        status: "error",
        summary: "That command needs an open conversation.",
      };
    }
    return presentAction(
      input.registry.invoke(parsed.actionId, parsed.args, {
        actor: "user_command",
        threadId: input.threadId,
      }),
    );
  }
  if (parsed.name !== "forget") {
    return { status: "error", summary: "That text is not a local command." };
  }
  const removed = input.store.remove(parsed.id, "user_command");
  return removed.ok
    ? { status: "success", summary: removed.summary }
    : { status: "error", summary: removed.summary };
}
