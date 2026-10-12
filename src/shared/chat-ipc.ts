import type { ActionResult } from "./action-contract";
import type { ChatSettings } from "./config";

export type ChatTurnStop =
  "completed" | "paused" | "cancelled" | "limit" | "capacity" | "no_progress";

export const ASSISTANT_STREAM_CHANNEL = "verbo:assistant-stream";

export type ChatMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
};

export type ChatRequest = {
  threadId: string;
  parentId?: string;
  assistantMessageId: string;
  system?: string;
  messages: ChatMessage[];
  settings: ChatSettings;
  queueItemId?: string;
  source?: "typed" | "voice";
  attachmentIds?: string[];
};

export type ChatToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type ChatEvent =
  | { type: "delta"; text: string }
  | {
      type: "tools";
      content: string;
      calls: ChatToolCall[];
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      args: unknown;
      result: ActionResult;
    }
  | { type: "turn_status"; stop: ChatTurnStop; summary?: string }
  | { type: "local_command"; newThread?: boolean; openMemory?: boolean }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "context_trimmed"; removedCount: number };

export type AssistantAI = {
  streamChat(
    request: ChatRequest,
    onEvent: (event: ChatEvent) => void,
  ): () => void;
};
