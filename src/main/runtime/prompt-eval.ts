import { randomUUID } from "node:crypto";
import type {
  InferenceMeasurement,
  InferenceSource,
} from "../../shared/inference-metrics";
import type { AgentId } from "../../shared/workflows";

const MAX_RECORDS = 256;

type MeasurementHandle = {
  start(): void;
  complete(value: unknown): void;
  finish(error?: unknown, cancelled?: boolean): void;
};
type MeasurementStore = {
  begin(source: InferenceSource): MeasurementHandle;
  latest(
    threadId: string | undefined,
    agentId: AgentId,
  ): InferenceMeasurement | null;
  list(): InferenceMeasurement[];
};

export function createInferenceMeasurements(
  limit = MAX_RECORDS,
): MeasurementStore {
  const records = new Map<string, InferenceMeasurement>();
  return {
    begin(source: InferenceSource) {
      const record: InferenceMeasurement = {
        ...structuredClone(source),
        requestId: randomUUID(),
        startedAt: Date.now(),
        status: "queued",
      };
      records.set(record.requestId, record);
      while (records.size > limit) records.delete(records.keys().next().value!);
      let completed = false;
      return {
        start(): void {
          record.queueWaitMs = Date.now() - record.startedAt;
          record.status = "running";
        },
        complete(value: unknown): void {
          if (!value || typeof value !== "object") return;
          const chunk = value as Record<string, unknown>;
          if (chunk.done !== true) return;
          completed = true;
          if (typeof chunk.model === "string") record.model = chunk.model;
          const fields = {
            prompt_eval_count: "promptTokens",
            eval_count: "generatedTokens",
            load_duration: "loadDurationNs",
            prompt_eval_duration: "promptEvalDurationNs",
            eval_duration: "evalDurationNs",
            total_duration: "totalDurationNs",
          } as const;
          for (const [wire, field] of Object.entries(fields)) {
            const number = chunk[wire];
            if (
              typeof number === "number" &&
              Number.isFinite(number) &&
              number >= 0
            )
              record[field] = number;
          }
        },
        finish(error?: unknown, cancelled = false): void {
          record.wallTimeMs = Date.now() - record.startedAt;
          record.status = cancelled
            ? "cancelled"
            : error !== undefined
              ? "failed"
              : completed
                ? "completed"
                : "incomplete";
        },
      };
    },
    latest(
      threadId: string | undefined,
      agentId: AgentId,
    ): InferenceMeasurement | null {
      if (!threadId) return null;
      const record = [...records.values()].findLast(
        (item) =>
          item.threadId === threadId &&
          item.agentId === agentId &&
          item.work === "foreground",
      );
      return record ? structuredClone(record) : null;
    },
    list(): InferenceMeasurement[] {
      return structuredClone([...records.values()]);
    },
  };
}

export const inferenceMeasurements = createInferenceMeasurements();
