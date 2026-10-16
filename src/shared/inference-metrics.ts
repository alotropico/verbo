import type { AgentId, WorkflowAttribution } from "./workflows";

export type InferenceSource = {
  threadId: string;
  turnId?: string;
  invocationId: string;
  agentId: AgentId | "title";
  modelProfileId?: string;
  work: "foreground" | "background";
  model: string;
  numCtx: number;
  attribution?: WorkflowAttribution;
};

/** Ollama durations are nanoseconds; application durations are milliseconds. */
export type InferenceMeasurement = InferenceSource & {
  requestId: string;
  startedAt: number;
  status:
    "queued" | "running" | "completed" | "incomplete" | "cancelled" | "failed";
  queueWaitMs?: number;
  wallTimeMs?: number;
  promptTokens?: number;
  generatedTokens?: number;
  loadDurationNs?: number;
  promptEvalDurationNs?: number;
  evalDurationNs?: number;
  totalDurationNs?: number;
};
