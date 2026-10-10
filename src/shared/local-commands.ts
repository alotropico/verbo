export const LOCAL_COMMANDS = [
  {
    name: "help",
    syntax: "/help",
    actionId: undefined,
    blurb: "List local commands",
  },
  {
    name: "capabilities",
    syntax: "/capabilities",
    actionId: undefined,
    blurb: "List registered actions",
  },
  {
    name: "remember",
    syntax: "/remember <text>",
    actionId: "memory.add",
    blurb: "Save a global always-on memory",
  },
  {
    name: "memories",
    syntax: "/memories",
    actionId: "memory.list",
    blurb: "Open memory settings",
  },
  {
    name: "forget",
    syntax: "/forget <id>",
    actionId: "memory.remove",
    blurb: "Remove a memory",
  },
] as const;

export type LocalCommandName = (typeof LOCAL_COMMANDS)[number]["name"];

export type LocalCommandResult = {
  status: "success" | "error";
  summary: string;
  openMemory?: boolean;
};

export type ParsedCommand =
  | { handled: false }
  | { handled: true; name: "help" }
  | { handled: true; name: "capabilities" }
  | { handled: true; name: "memories" }
  | { handled: true; name: "remember"; text: string }
  | { handled: true; name: "forget"; id: string }
  | { handled: true; name: "malformed"; summary: string };

const known = new Set<string>(LOCAL_COMMANDS.map((command) => command.name));

export function parseLocalCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { handled: false };
  const match = /^\/([A-Za-z][A-Za-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return {
      handled: true,
      name: "malformed",
      summary: "That command could not be read. Use /help.",
    };
  }
  const name = match[1]?.toLowerCase() ?? "";
  const rest = match[2]?.trim() ?? "";
  if (!known.has(name)) {
    return {
      handled: true,
      name: "malformed",
      summary: `Unknown command /${name}. Use /help.`,
    };
  }
  if (name === "help") {
    if (rest) {
      return {
        handled: true,
        name: "malformed",
        summary: "/help takes no arguments.",
      };
    }
    return { handled: true, name: "help" };
  }
  if (name === "capabilities") {
    if (rest) {
      return {
        handled: true,
        name: "malformed",
        summary: "/capabilities takes no arguments.",
      };
    }
    return { handled: true, name: "capabilities" };
  }
  if (name === "memories") {
    if (rest) {
      return {
        handled: true,
        name: "malformed",
        summary: "/memories takes no arguments.",
      };
    }
    return { handled: true, name: "memories" };
  }
  if (name === "remember") {
    if (!rest) {
      return {
        handled: true,
        name: "malformed",
        summary: "/remember needs the text to save.",
      };
    }
    return { handled: true, name: "remember", text: rest };
  }
  const id = rest.split(/\s+/u)[0] ?? "";
  if (!id || rest.split(/\s+/u).length !== 1) {
    return {
      handled: true,
      name: "malformed",
      summary: "/forget needs one memory id.",
    };
  }
  return { handled: true, name: "forget", id };
}

/** A leading slash is a local command, including unknown or malformed ones. */
export function modelRoute(text: string): "local" | "model" {
  return parseLocalCommand(text).handled ? "local" : "model";
}
