import { parseActionCommand, parseFilesCommand } from "./file-commands";

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
  {
    name: "files",
    syntax: "/files list|find|grep|stat|summary|read|next",
    actionId: undefined,
    blurb: "Query or read a file through the file actions",
  },
  {
    name: "action",
    syntax: "/action <id> <JSON>",
    actionId: undefined,
    blurb: "Run any registered action. Approval is not a command",
  },
  {
    name: "new",
    syntax: "/new",
    actionId: undefined,
    blurb: "Open a blank conversation. Stored chats stay in the list",
  },
] as const;

export type LocalCommandName = (typeof LOCAL_COMMANDS)[number]["name"];

export type LocalCommandResult = {
  status: "success" | "error";
  summary: string;
  openMemory?: boolean;
  newThread?: boolean;
};

export type ParsedCommand =
  | { handled: false }
  | { handled: true; name: "help" }
  | { handled: true; name: "capabilities" }
  | { handled: true; name: "memories" }
  | { handled: true; name: "remember"; text: string }
  | { handled: true; name: "forget"; id: string }
  | {
      handled: true;
      name: "files" | "action";
      actionId: string;
      args: Record<string, unknown>;
    }
  | { handled: true; name: "new" }
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
  if (name === "new") {
    if (rest) {
      return {
        handled: true,
        name: "malformed",
        summary: "/new takes no arguments.",
      };
    }
    return { handled: true, name: "new" };
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
  if (name === "files" || name === "action") {
    const parsed =
      name === "files" ? parseFilesCommand(rest) : parseActionCommand(rest);
    if (!parsed.ok) {
      return { handled: true, name: "malformed", summary: parsed.summary };
    }
    return {
      handled: true,
      name,
      actionId: parsed.call.actionId,
      args: parsed.call.args,
    };
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

const VOICE_NEW_CHAT = new Set(["clear chat", "empty chat"]);
const VOICE_CONTROLS = new Set(["stop", "cancel"]);

function standaloneSpeech(text: string): string | null {
  const trimmed = text.trim();
  if (/["'“”‘’]/u.test(trimmed)) return null;
  return trimmed.replace(/\s+/gu, " ").toLowerCase();
}

/** Finalized standalone speech only. Quotes and extra words stay ordinary text. */
export function parseVoiceCommand(
  text: string,
): { handled: false } | { handled: true; name: "new" } {
  const normalized = standaloneSpeech(text);
  if (!normalized || !VOICE_NEW_CHAT.has(normalized)) return { handled: false };
  return { handled: true, name: "new" };
}

/** Exact finalized `stop` or `cancel` only. Sentences stay ordinary speech. */
export function parseVoiceControl(
  text: string,
): { handled: false } | { handled: true; name: "stop" | "cancel" } {
  const normalized = standaloneSpeech(text);
  if (!normalized || !VOICE_CONTROLS.has(normalized)) return { handled: false };
  return { handled: true, name: normalized === "stop" ? "stop" : "cancel" };
}

export function routeUtterance(
  text: string,
  source: "typed" | "voice" = "typed",
): { kind: "model" } | { kind: "new-chat" } | { kind: "local" } {
  if (source === "voice") {
    return parseVoiceCommand(text).handled
      ? { kind: "new-chat" }
      : { kind: "model" };
  }
  const parsed = parseLocalCommand(text);
  if (!parsed.handled) return { kind: "model" };
  if (parsed.name === "new") return { kind: "new-chat" };
  return { kind: "local" };
}
