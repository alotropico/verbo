import type { CommandNode } from "../../shared/commands";
import type { ContextSource } from "./cts";

/** Summarize the current owner catalog without copying every command schema. */
export function commandContextSource(nodes: CommandNode[]): ContextSource {
  const modules = nodes.filter((node) => !node.id.includes("."));
  return {
    id: "commands",
    audience: ["conversational", "commander"],
    kind: "instructions",
    text: [
      "Registered command modules from the current Alo catalog (execution remains subject to invocation permissions):",
      ...modules.map((node) => `- ${node.id}: ${node.description}`),
      "Commander discovers command syntax with capabilities.search, or capabilities.list for a known module, then executes through actions.invoke. Conversational turns cannot execute commands; do not infer that Verbo lacks a capability because this turn has no tools.",
      ...(nodes.some((node) => node.id === "projects.list")
        ? [
            "Registered projects are separate from workspace folder scopes. Folder cards do not enumerate added projects. For project availability, discover projects.list and invoke it with the returned syntax; do not ask the user to supply project paths or configure projects before checking. Use returned aliases for subsequent project commands. Registration alone does not grant file write access.",
          ]
        : []),
    ].join("\n"),
  };
}
