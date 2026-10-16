import { z } from "zod";
import { agentIdSchema, type AgentId } from "./workflows";
export const contextAudiences = agentIdSchema.options;
export const contextAudiencesSchema = z
  .array(agentIdSchema)
  .max(4)
  .refine(
    (values) => new Set(values).size === values.length,
    "Duplicate recipient.",
  );

/** Hard cap for global entries with inclusion `always`. Override only in the store. */
export const ALWAYS_ON_MEMORY_TOKEN_BUDGET = 512;

export const memoryScopes = ["global", "thread"] as const;
export const memoryInclusions = ["always", "on_demand"] as const;
export const memorySources = ["user", "model", "settings"] as const;

export const memoryTextSchema = z.string().trim().min(1).max(8000);
export const memoryIdSchema = z.string().trim().min(1).max(128);

export const memoryAddArgsSchema = z
  .object({
    text: memoryTextSchema,
    scope: z.enum(memoryScopes).default("global"),
    inclusion: z.enum(memoryInclusions).default("on_demand"),
    threadId: memoryIdSchema.optional(),
    audiences: contextAudiencesSchema.default(["conversational"]),
  })
  .strict();

export const memoryUpdateArgsSchema = z
  .object({
    id: memoryIdSchema,
    text: memoryTextSchema.optional(),
    inclusion: z.enum(memoryInclusions).optional(),
    audiences: contextAudiencesSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.text !== undefined ||
      value.inclusion !== undefined ||
      value.audiences !== undefined,
    {
      message: "Update needs text or inclusion.",
    },
  );

export const memoryRemoveArgsSchema = z
  .object({
    id: memoryIdSchema,
  })
  .strict();

export const memoryGetArgsSchema = z
  .object({
    ids: z.array(memoryIdSchema).min(1).max(8),
  })
  .strict();

export const memoryListArgsSchema = z
  .object({
    scope: z.enum(memoryScopes).optional(),
    inclusion: z.enum(memoryInclusions).optional(),
    threadId: memoryIdSchema.optional(),
    query: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(40).optional(),
  })
  .strict();

export const memoryBrowserSchema = z
  .object({
    scope: z.enum(memoryScopes).optional(),
    threadId: memoryIdSchema.optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

export const memoryCommandSchema = z
  .object({
    text: z.string().min(1).max(8000),
    threadId: memoryIdSchema.optional(),
    source: z.enum(["typed", "voice"]).optional(),
  })
  .strict();

export const contextEstimateSchema = z
  .object({
    threadId: memoryIdSchema.optional(),
    audience: agentIdSchema.optional(),
  })
  .strict();

export type MemoryScope = (typeof memoryScopes)[number];
export type MemoryInclusion = (typeof memoryInclusions)[number];
export type MemorySource = (typeof memorySources)[number];

export type MemoryRecord = {
  audiences: AgentId[];
  id: string;
  scope: MemoryScope;
  threadId: string | null;
  text: string;
  inclusion: MemoryInclusion;
  source: MemorySource;
  originThreadId: string | null;
  originTurnId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type MemoryChange = {
  id: string;
  entryId: string;
  actor: string;
  change: "add" | "update" | "remove";
  summary: string;
  createdAt: number;
};

export type MemorySnapshot = {
  alwaysGlobal: string[];
  alwaysThread: string[];
  onDemandGlobalCount: number;
  onDemandThreadCount: number;
};

export type MemoryUsage = {
  tokens: number;
  budget: number;
};

export type ContextMeters = {
  memoryTokens: number;
  memoryBudget: number;
  contextTokens: number;
  contextWindow: number;
  lastInference: import("./inference-metrics").InferenceMeasurement | null;
};

export function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export type MeterLevel = "ok" | "warn" | "high";

/** Under 70% ok, 70–90% warn, over 90% high. */
export function meterLevel(used: number, total: number): MeterLevel {
  if (total <= 0) return "ok";
  const ratio = used / total;
  if (ratio > 0.9) return "high";
  if (ratio >= 0.7) return "warn";
  return "ok";
}

export function formatEstimatedTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}
