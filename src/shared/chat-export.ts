export type ChatExportMessage = {
  id: string;
  parentId: string | null;
  role: string;
  content: unknown;
  [key: string]: unknown;
};

const MESSAGE_RUNTIME_KEYS = [
  "branchCount",
  "branchNumber",
  "composer",
  "dataRendererUI",
  "index",
  "isCopied",
  "isHovering",
  "isLast",
  "parts",
  "speech",
  "submission",
  "toolUI",
] as const;

function isBinary(value: object): boolean {
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer)
    return true;
  return typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value);
}

/** JSON-safe copy. Drops functions, binary values, and React elements. */
export function exportJsonValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error)
    return { name: value.name, message: value.message };
  if (
    seen.has(value) ||
    isBinary(value) ||
    ("nodeType" in value &&
      typeof (value as { nodeType: unknown }).nodeType === "number")
  )
    return undefined;
  if ("$$typeof" in value) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      const next = exportJsonValue(item, seen);
      return next === undefined ? null : next;
    });
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "toolUI" || key === "dataRendererUI") continue;
    const next = exportJsonValue(child, seen);
    if (next !== undefined) out[key] = next;
  }
  return out;
}

export function exportMessageRecord(
  message: unknown,
): Record<string, unknown> | null {
  const data = exportJsonValue(message);
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return null;
  const record = data as Record<string, unknown>;
  for (const key of MESSAGE_RUNTIME_KEYS) delete record[key];
  return record;
}

export function messageExportJson(
  message: unknown,
  interaction?: unknown,
): string {
  const record = exportMessageRecord(message) ?? {};
  const assistantMessageId =
    typeof interaction === "object" &&
    interaction !== null &&
    "assistantMessageId" in interaction
      ? interaction.assistantMessageId
      : undefined;
  const body =
    assistantMessageId !== undefined && assistantMessageId === record.id
      ? { ...record, interaction: exportJsonValue(interaction) }
      : record;
  return `${JSON.stringify(body, null, 2)}\n`;
}

export type ChatExport = {
  id: string;
  title: string;
  headId: string | null;
  messages: ChatExportMessage[];
};

export function readExportMessages(
  rows: readonly { message: unknown; parentId: string | null }[],
): ChatExportMessage[] {
  return rows.flatMap((row) => {
    if (typeof row.message !== "object" || row.message === null) return [];
    const message = row.message as Record<string, unknown>;
    if (typeof message.id !== "string" || message.id.length === 0) return [];
    const role = typeof message.role === "string" ? message.role : "assistant";
    const record = exportMessageRecord(message) ?? {};
    return [
      {
        ...record,
        id: message.id,
        parentId: row.parentId,
        role,
        content: record.content ?? message.content ?? [],
      },
    ];
  });
}

/** Root-to-head path. Sibling branches stay out of the transcript. */
export function activeBranch(
  messages: readonly ChatExportMessage[],
  headId: string | null,
): ChatExportMessage[] {
  if (messages.length === 0) return [];
  const byId = new Map(messages.map((message) => [message.id, message]));
  const head = (headId ? byId.get(headId) : undefined) ?? messages.at(-1);
  if (!head) return [];
  const chain: ChatExportMessage[] = [];
  const seen = new Set<string>();
  let current: ChatExportMessage | undefined = head;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain.reverse();
}

export function chatExportAdvanced(
  chat: ChatExport,
  interaction?: unknown,
): string {
  const messages = activeBranch(chat.messages, chat.headId).map((message) => {
    const record = exportMessageRecord(message) ?? {};
    return {
      ...record,
      id: message.id,
      parentId: message.parentId,
      role: message.role,
      content: record.content ?? message.content,
    };
  });
  const body: Record<string, unknown> = {
    id: chat.id,
    title: chat.title,
    headId: chat.headId,
    messages,
  };
  if (interaction !== undefined && interaction !== null)
    body.interaction = exportJsonValue(interaction);
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function chatExportJson(chat: ChatExport): string {
  const messages = activeBranch(chat.messages, chat.headId);
  return `${JSON.stringify(
    {
      id: chat.id,
      title: chat.title,
      messages: messages.map((message) => ({
        id: message.id,
        parentId: message.parentId,
        role: message.role,
        content: message.content,
      })),
    },
    null,
    2,
  )}\n`;
}

function roleLabel(role: string): string {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "system") return "System";
  return role.slice(0, 1).toUpperCase() + role.slice(1);
}

function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function partMarkdown(part: unknown): string {
  if (typeof part === "string") return part.trim();
  if (typeof part !== "object" || part === null) return "";
  const record = part as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return record.text.trim();
  }
  if (record.type === "reasoning" && typeof record.text === "string") {
    const text = record.text.trim();
    return text ? quoteBlock(text) : "";
  }
  if (record.type === "tool-call") {
    const name = typeof record.toolName === "string" ? record.toolName : "tool";
    const result = record.result;
    const summary =
      typeof result === "object" &&
      result !== null &&
      "summary" in result &&
      typeof result.summary === "string"
        ? result.summary.trim()
        : "";
    return summary ? `**${name}:** ${summary}` : `**${name}**`;
  }
  if (record.type === "image") {
    const name =
      typeof record.filename === "string" ? record.filename : "image";
    return `[Image: ${name}]`;
  }
  if (record.type === "file") {
    const name = typeof record.filename === "string" ? record.filename : "file";
    return `[File: ${name}]`;
  }
  return "";
}

function messageMarkdown(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => partMarkdown(part))
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function chatExportMarkdown(
  chat: ChatExport,
  { textOnly = false }: { textOnly?: boolean } = {},
): string {
  const messages = activeBranch(chat.messages, chat.headId);
  const body = messages
    .flatMap((message) => {
      if (textOnly && !["user", "assistant"].includes(message.role)) return [];
      const content =
        textOnly && Array.isArray(message.content)
          ? message.content.filter(
              (part: unknown) =>
                typeof part === "string" ||
                (typeof part === "object" &&
                  part !== null &&
                  "type" in part &&
                  part.type === "text"),
            )
          : message.content;
      const text = messageMarkdown(content);
      if (textOnly && !text) return [];
      return [
        text
          ? `## ${roleLabel(message.role)}\n\n${text}`
          : `## ${roleLabel(message.role)}`,
      ];
    })
    .join("\n\n");
  return body ? `# ${chat.title}\n\n${body}\n` : `# ${chat.title}\n`;
}

export function chatExportFilename(
  title: string,
  extension: "json" | "md",
): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80);
  return `${cleaned || "chat"}.${extension}`;
}
