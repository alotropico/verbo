import { createAloMemoryStore } from "../alo/data-client";
import type { AsyncMethods } from "../alo/async";

import type { DatabaseSync } from "node:sqlite";

import type { ActorKind } from "../../shared/action-contract";

import {
  ALWAYS_ON_MEMORY_TOKEN_BUDGET,
  type MemoryChange,
  type MemoryInclusion,
  type MemoryRecord,
  type MemoryScope,
  type MemorySnapshot,
  type MemoryUsage,
} from "../../shared/memory";

import { type AgentId } from "../../shared/workflows";

export type MemoryListFilter = {
  audience?: AgentId;
  scope?: MemoryScope;
  inclusion?: MemoryInclusion;
  threadId?: string;
  query?: string;
  limit?: number;
  offset?: number;
  unassignedFirst?: boolean;
};

export type MemoryWrite = {
  audiences?: AgentId[];
  text: string;
  scope: MemoryScope;
  inclusion: MemoryInclusion;
  threadId?: string;
  actor: ActorKind;
  originThreadId?: string;
  originTurnId?: string;
};

export type MemoryPatch = {
  audiences?: AgentId[];
  id: string;
  text?: string;
  inclusion?: MemoryInclusion;
  actor: ActorKind;
};

export type MemoryFailure = {
  ok: false;
  code: string;
  summary: string;
};

export type MemorySuccess = {
  ok: true;
  summary: string;
  entry?: MemoryRecord;
};

export type MemoryStore = {
  budget: number;
  list: (filter: MemoryListFilter) => {
    entries: MemoryRecord[];
    more: boolean;
  };
  get: (ids: readonly string[]) => MemoryRecord[];
  add: (write: MemoryWrite) => MemoryFailure | MemorySuccess;
  update: (patch: MemoryPatch) => MemoryFailure | MemorySuccess;
  remove: (id: string, actor: ActorKind) => MemoryFailure | MemorySuccess;
  snapshot: (threadId?: string, audience?: AgentId) => MemorySnapshot;
  usage: (audience?: AgentId) => MemoryUsage;
  recentChanges: (limit?: number) => MemoryChange[];
};

export function createMemoryStore(database: DatabaseSync, budget = ALWAYS_ON_MEMORY_TOKEN_BUDGET): AsyncMethods<MemoryStore> {
  return createAloMemoryStore(database, budget);
}
