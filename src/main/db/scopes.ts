import { createAloScopeStore } from "../alo/data-client";
import type { AsyncMethods } from "../alo/async";

import type { DatabaseSync } from "node:sqlite";

import type { ActorKind } from "../../shared/action-contract";

import {
  type FileGrantKind,
  type FileGrantRecord,
  type FileScopeProposal,
  type FileScopeRecord,
  type FolderKind,
} from "../../shared/files";

export type ScopeAddition = {
  routingDescription?: string;
  alias: string;
  path: string;
  read: boolean;
  write: boolean;
  defaultSave: boolean;
  kind?: FolderKind;
};

export type ScopeUpdate = {
  routingDescription?: string;
  id: string;
  alias: string;
  read: boolean;
  write: boolean;
  defaultSave: boolean;
  kind?: FolderKind;
};

export type ScopeFailure = {
  ok: false;
  code: string;
  summary: string;
};

export type ScopeSuccess = {
  ok: true;
  summary: string;
  scopes: FileScopeRecord[];
};

export type ScopeStore = {
  list: () => FileScopeRecord[];
  proposal: (projectRoot?: string) => FileScopeProposal;
  generation: () => number;
  apply: (input: {
    removeIds: readonly string[];
    updates: readonly ScopeUpdate[];
    additions: readonly ScopeAddition[];
  }) => ScopeFailure | ScopeSuccess;
  issueReadGrant: (input: {
    actor: ActorKind;
    kind: FileGrantKind;
    path: string;
    threadId?: string;
  }) => ScopeFailure | { ok: true; summary: string; grant: FileGrantRecord };
  activeGrants: () => FileGrantRecord[];
};

export function createScopeStore(database: DatabaseSync, _options?: { now?: () => number }): AsyncMethods<ScopeStore> {
  void _options; // Retain the existing app-facing signature; storage belongs to Alo.

  return createAloScopeStore(database);
}
