import type { ActionResult } from "../../shared/action-contract";
import { LOCAL_COMMANDS, parseLocalCommand, routeUtterance, type LocalCommandResult } from "../../shared/local-commands";
import type { CapabilityRegistry, DescribeResult, SearchResult } from "../capabilities/registry";
import type { MemoryStore } from "../db/memory";
import type { AsyncMethods } from "../alo/async";

function presentAction(result: ActionResult): LocalCommandResult {
  const handled = result.status === "success" || result.status === "partial" || result.status === "requires_confirmation";
  const summary = result.detail ? `${result.summary}\n${result.detail}` : result.summary;
  return { status: handled ? "success" : "error", summary, receipt: result };
}

async function describeEntries(registry: CapabilityRegistry, ids: string[]): Promise<Map<string, DescribeResult["entries"][number]>> {
  const entries = new Map<string, DescribeResult["entries"][number]>();
  for (let offset = 0; offset < ids.length; offset += 8) {
    for (const entry of (await registry.describe(ids.slice(offset, offset + 8))).entries) entries.set(entry.id, entry);
  }
  return entries;
}

async function helpText(registry: CapabilityRegistry): Promise<string> {
  const nodes = await registry.nodes();
  const entries = await describeEntries(registry, [
    ...new Set([...nodes.map((node) => node.id), ...LOCAL_COMMANDS.flatMap((command) => (command.actionId ? [command.actionId] : []))]),
  ]);
  const conveniences = LOCAL_COMMANDS.map((command) => {
    if (!command.actionId) return `${command.syntax} — ${command.blurb}`;
    const described = entries.get(command.actionId);
    const detail = described?.description ?? command.blurb;
    return `${command.syntax} — ${command.actionId}. ${detail}`;
  });
  const definitions = nodes.map((node) => {
    const described = entries.get(node.id);
    const aliases = node.aliases.length ? ` (${node.aliases.join(", ")})` : "";
    return `${described?.kind === "category" ? node.id : `/${node.id} ${described?.syntax ?? "{}"}`}${aliases} — ${node.description}`;
  });
  return [...conveniences, "", "Canonical paths and aliases accept JSON arguments:", ...definitions].join("\n");
}

function searchText(found: SearchResult): string {
  if (found.status === "error") return found.summary ?? "Search failed.";
  if (found.matches.length === 0) return `No commands match ${found.query}.`;
  const lines = found.matches.map((match) => {
    const aliases = match.aliases?.length ? ` (${match.aliases.join(", ")})` : "";
    const syntax = match.syntax ? `${match.syntax} ` : "";
    return `${match.id}${aliases} — ${syntax}${match.description}`;
  });
  if (found.more) lines.push("More matches were omitted.");
  return lines.join("\n");
}

async function catalogText(registry: CapabilityRegistry): Promise<string> {
  const lines = ["Registered capabilities:"];
  const nodes = await registry.nodes();
  const entries = await describeEntries(
    registry,
    nodes.map((node) => node.id),
  );
  for (const node of nodes) {
    const entry = entries.get(node.id);
    if (entry?.kind !== "category")
      lines.push(`${node.id}${node.aliases.length ? ` (${node.aliases.join(", ")})` : ""} — ${node.description}`);
  }
  return lines.join("\n");
}

export async function executeLocalCommand(input: {
  text: string;
  source?: "typed" | "voice";
  threadId?: string;
  store: MemoryStore | AsyncMethods<MemoryStore>;
  registry: CapabilityRegistry;
  turnId?: string;
  signal?: AbortSignal;
}): Promise<LocalCommandResult> {
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
    return { status: "success", summary: await helpText(input.registry) };
  }
  if (parsed.name === "capabilities") {
    return { status: "success", summary: await catalogText(input.registry) };
  }
  if (parsed.name === "search") {
    const found = await input.registry.search(parsed.query);
    return {
      status: found.status === "error" ? "error" : "success",
      summary: searchText(found),
    };
  }
  if (parsed.name === "memories") {
    return {
      status: "success",
      summary: "Opened memory settings.",
      openMemory: true,
    };
  }
  if (parsed.name === "remember") {
    return presentAction(
      await input.registry.invoke(
        "memory.add",
        {
          text: parsed.text,
          scope: "global",
          inclusion: "always",
          audiences: ["conversational"],
        },
        {
          actor: "user_command",
          threadId: input.threadId ?? "settings",
          turnId: input.turnId,
          signal: input.signal,
        },
      ),
    );
  }
  if (parsed.name === "files" || parsed.name === "action") {
    if (!input.threadId) {
      return {
        status: "error",
        summary: "That command needs an open conversation.",
      };
    }
    return presentAction(
      await input.registry.invoke(parsed.actionId, parsed.args, {
        actor: "user_command",
        threadId: input.threadId,
        turnId: input.turnId,
        signal: input.signal,
      }),
    );
  }
  if (parsed.name !== "forget") {
    return { status: "error", summary: "That text is not a local command." };
  }
  return presentAction(
    await input.registry.invoke(
      "memory.remove",
      { id: parsed.id },
      {
        actor: "user_command",
        threadId: input.threadId ?? "settings",
        turnId: input.turnId,
        signal: input.signal,
      },
    ),
  );
}
