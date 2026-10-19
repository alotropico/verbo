import type { ActionResult } from "./action-contract";
import type { ChatSettings } from "./config";
import type { BackendNotice } from "./backend-notice";
import type { ExecutionTrace } from "./execution-trace";
import type {
  WorkflowStage,
  ExecutionSummary,
  RoutingStage,
  WorkflowAttribution,
} from "./workflows";

export type ChatTurnStop =
  | "completed"
  | "paused"
  | "cancelled"
  | "limit"
  | "capacity"
  | "no_progress"
  | "failed";

export const USER_ABORT_NOTICE = "You stopped this reply.";

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

export type ChatEvent = (
  | {
      type: "turn_identity";
      turnId: string;
      threadId: string;
      userMessageId: string;
      assistantMessageId: string;
      userSentAt?: number;
    }
  | { type: "stage"; stage: WorkflowStage }
  | { type: "routing_stage"; stage: RoutingStage }
  | { type: "execution"; execution: ExecutionSummary }
  | {
      type: "finalization";
      turnId: string;
      threadId: string;
      assistantMessageId: string;
      state: "failed" | "saved";
      message?: string;
    }
  | { type: "backend_notice"; notice: BackendNotice }
  | { type: "delta"; text: string }
  | {
      type: "tools";
      content: string;
      calls: ChatToolCall[];
      attribution?: WorkflowAttribution;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      args: unknown;
      result: ActionResult;
      attribution?: WorkflowAttribution;
    }
  | {
      type: "approval";
      toolCallId: string;
      name: string;
      args: unknown;
      result: ActionResult;
      attribution?: WorkflowAttribution;
    }
  | { type: "turn_status"; stop: ChatTurnStop; summary?: string }
  | {
      type: "trace_clock";
      turnId?: string;
      workStartedAt?: number;
      approvalDeltaMs?: number;
      reporting?: boolean;
      resultReadyAt?: number;
      stop?: ChatTurnStop;
    }
  | { type: "execution_trace"; trace: ExecutionTrace }
  | { type: "local_command"; newThread?: boolean; openMemory?: boolean }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "context_trimmed"; removedCount: number }
  | { type: "exchange"; interaction: LatestInteraction }
) & { deliveryId?: string; sequence?: number };

/** One model round: context assembled for the turn, then the Ollama request and raw response chunks. */
export type ExchangeRound = {
  context: unknown;
  request: unknown;
  response: unknown[];
};

/** Latest turn of one chat. Held in renderer localStorage, not the database. */
export type LatestInteraction = {
  assistantMessageId: string;
  threadId: string;
  rounds: ExchangeRound[];
};

export type AssistantAI = {
  streamChat(
    request: ChatRequest,
    onEvent: (event: ChatEvent) => void,
  ): () => void;
};
