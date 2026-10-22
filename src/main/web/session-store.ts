import { randomUUID } from "node:crypto";
import type { EngineFailure, EngineId, OrganicResult, SearchPage, WebFailure } from "../../shared/web";

export const MAX_SNAPSHOTS = 32;
export const SNAPSHOT_TTL_MS = 15 * 60 * 1000; // 15 minutes

type SearchSnapshot = {
  id: string;
  createdAt: number;
  query: string;
  results: OrganicResult[];
  enginesUsed: EngineId[];
  unresponsiveEngines: EngineFailure[];
  defaultPageSize: number;
};

type CursorEntry = {
  snapshotId: string;
  offset: number;
};

export class SessionStore {
  private readonly snapshots = new Map<string, SearchSnapshot>();
  private readonly cursors = new Map<string, CursorEntry>();

  constructor(
    private readonly maxSnapshots = MAX_SNAPSHOTS,
    private readonly ttlMs = SNAPSHOT_TTL_MS,
  ) {}

  public prune(now = Date.now()): void {
    // 1. Remove expired snapshots
    for (const [id, snapshot] of this.snapshots.entries()) {
      if (now - snapshot.createdAt >= this.ttlMs) {
        this.snapshots.delete(id);
      }
    }

    // 2. Oldest-created eviction if over limit
    if (this.snapshots.size > this.maxSnapshots) {
      const sorted = Array.from(this.snapshots.values()).sort((a, b) => a.createdAt - b.createdAt);
      const toRemove = sorted.slice(0, this.snapshots.size - this.maxSnapshots);
      for (const item of toRemove) {
        this.snapshots.delete(item.id);
      }
    }

    // 3. Remove orphaned cursors
    for (const [cursor, entry] of this.cursors.entries()) {
      if (!this.snapshots.has(entry.snapshotId)) {
        this.cursors.delete(cursor);
      }
    }
  }

  public createSession(
    params: {
      query: string;
      results: OrganicResult[];
      enginesUsed: EngineId[];
      unresponsiveEngines: EngineFailure[];
      pageSize: number;
    },
    now = Date.now(),
    uuid: () => string = randomUUID,
  ): SearchPage {
    this.prune(now);

    const totalCached = params.results.length;
    if (totalCached === 0) {
      return {
        ok: true,
        query: params.query,
        results: [],
        returnedCount: 0,
        totalCached: 0,
        hasMore: false,
        enginesUsed: params.enginesUsed,
        unresponsiveEngines: params.unresponsiveEngines,
      };
    }

    const firstSlice = params.results.slice(0, params.pageSize);
    const nextOffset = firstSlice.length;
    const hasMore = nextOffset < totalCached;

    if (!hasMore) {
      return {
        ok: true,
        query: params.query,
        results: firstSlice,
        returnedCount: firstSlice.length,
        totalCached,
        hasMore: false,
        enginesUsed: params.enginesUsed,
        unresponsiveEngines: params.unresponsiveEngines,
      };
    }

    const snapshotId = uuid();
    const snapshot: SearchSnapshot = {
      id: snapshotId,
      createdAt: now,
      query: params.query,
      results: params.results,
      enginesUsed: params.enginesUsed,
      unresponsiveEngines: params.unresponsiveEngines,
      defaultPageSize: params.pageSize,
    };

    this.snapshots.set(snapshotId, snapshot);
    this.prune(now);

    // If snapshot was evicted immediately by maxSnapshots limit
    if (!this.snapshots.has(snapshotId)) {
      return {
        ok: true,
        query: params.query,
        results: firstSlice,
        returnedCount: firstSlice.length,
        totalCached,
        hasMore: false,
        enginesUsed: params.enginesUsed,
        unresponsiveEngines: params.unresponsiveEngines,
      };
    }

    const cursorId = uuid();
    this.cursors.set(cursorId, {
      snapshotId,
      offset: nextOffset,
    });

    return {
      ok: true,
      query: params.query,
      results: firstSlice,
      returnedCount: firstSlice.length,
      totalCached,
      hasMore: true,
      nextCursor: cursorId,
      enginesUsed: params.enginesUsed,
      unresponsiveEngines: params.unresponsiveEngines,
    };
  }

  public next(
    cursor: string,
    pageSizeOverride?: number,
    signal?: AbortSignal,
    now = Date.now(),
    uuid: () => string = randomUUID,
  ): SearchPage | WebFailure {
    if (signal?.aborted) {
      return {
        ok: false,
        code: "cancelled",
        detail: "Search pagination was cancelled.",
      };
    }

    if (pageSizeOverride !== undefined) {
      if (typeof pageSizeOverride !== "number" || !Number.isInteger(pageSizeOverride) || pageSizeOverride < 1 || pageSizeOverride > 10) {
        return {
          ok: false,
          code: "invalid_request",
          detail: "Page size must be an integer between 1 and 10.",
        };
      }
    }

    this.prune(now);

    if (!cursor || typeof cursor !== "string") {
      return {
        ok: false,
        code: "cursor_expired",
        detail: "Search cursor is invalid or expired.",
      };
    }

    // Atomically consume cursor
    const entry = this.cursors.get(cursor);
    if (!entry) {
      return {
        ok: false,
        code: "cursor_expired",
        detail: "Search cursor is invalid or expired.",
      };
    }
    this.cursors.delete(cursor);

    const snapshot = this.snapshots.get(entry.snapshotId);
    if (!snapshot) {
      return {
        ok: false,
        code: "cursor_expired",
        detail: "Search cursor is invalid or expired.",
      };
    }

    if (now - snapshot.createdAt >= this.ttlMs) {
      this.snapshots.delete(entry.snapshotId);
      return {
        ok: false,
        code: "cursor_expired",
        detail: "Search cursor is invalid or expired.",
      };
    }

    const effectivePageSize = pageSizeOverride ?? snapshot.defaultPageSize;
    const slice = snapshot.results.slice(entry.offset, entry.offset + effectivePageSize);
    const nextOffset = entry.offset + slice.length;
    const hasMore = nextOffset < snapshot.results.length;

    let nextCursor: string | undefined = undefined;
    if (hasMore) {
      nextCursor = uuid();
      this.cursors.set(nextCursor, {
        snapshotId: snapshot.id,
        offset: nextOffset,
      });
    }

    return {
      ok: true,
      query: snapshot.query,
      results: slice,
      returnedCount: slice.length,
      totalCached: snapshot.results.length,
      hasMore,
      nextCursor,
      enginesUsed: snapshot.enginesUsed,
      unresponsiveEngines: snapshot.unresponsiveEngines,
    };
  }

  public dispose(): void {
    this.snapshots.clear();
    this.cursors.clear();
  }

  public get snapshotCount(): number {
    return this.snapshots.size;
  }

  public get cursorCount(): number {
    return this.cursors.size;
  }
}
