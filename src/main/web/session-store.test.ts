import { describe, expect, it } from "vitest";
import type { OrganicResult } from "../../shared/web";
import { MAX_SNAPSHOTS, SessionStore, SNAPSHOT_TTL_MS } from "./session-store";

function makeResults(count: number): OrganicResult[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `Result ${i + 1}`,
    url: `https://example.com/${i + 1}`,
    snippet: `Snippet ${i + 1}`,
    engine: "duckduckgo",
  }));
}

describe("session-store", () => {
  it("handles empty search results with 0/0/false and no stored snapshot", () => {
    const store = new SessionStore();
    const page = store.createSession({
      query: "empty",
      results: [],
      enginesUsed: ["duckduckgo"],
      unresponsiveEngines: [],
      pageSize: 5,
    });
    expect(page.ok).toBe(true);
    expect(page.returnedCount).toBe(0);
    expect(page.totalCached).toBe(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
    expect(store.snapshotCount).toBe(0);
  });

  it("handles exact 1 page without creating continuation cursor", () => {
    const store = new SessionStore();
    const results = makeResults(5);
    const page = store.createSession({
      query: "five",
      results,
      enginesUsed: ["duckduckgo"],
      unresponsiveEngines: [],
      pageSize: 5,
    });
    expect(page.ok).toBe(true);
    expect(page.returnedCount).toBe(5);
    expect(page.totalCached).toBe(5);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
    expect(store.snapshotCount).toBe(0);
  });

  it("paginates across multiple pages with rotating single-use cursors", () => {
    const store = new SessionStore();
    const results = makeResults(12);

    // Initial search: returns 5 results, hasMore true, issues cursor 1
    const page1 = store.createSession({
      query: "twelve",
      results,
      enginesUsed: ["duckduckgo"],
      unresponsiveEngines: [],
      pageSize: 5,
    });
    expect(page1.ok).toBe(true);
    expect(page1.returnedCount).toBe(5);
    expect(page1.totalCached).toBe(12);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    const cursor1 = page1.nextCursor!;

    // Page 2: returns next 5 results, hasMore true, issues cursor 2
    const page2 = store.next(cursor1);
    expect(page2.ok).toBe(true);
    if (page2.ok) {
      expect(page2.returnedCount).toBe(5);
      expect(page2.totalCached).toBe(12);
      expect(page2.hasMore).toBe(true);
      expect(page2.results[0].title).toBe("Result 6");
      expect(page2.nextCursor).toBeDefined();
      expect(page2.nextCursor).not.toBe(cursor1);

      // Replaying cursor 1 fails with cursor_expired
      const replay = store.next(cursor1);
      expect(replay.ok).toBe(false);
      if (!replay.ok) {
        expect(replay.code).toBe("cursor_expired");
      }

      const cursor2 = page2.nextCursor!;

      // Page 3: returns last 2 results, hasMore false, no nextCursor
      const page3 = store.next(cursor2);
      expect(page3.ok).toBe(true);
      if (page3.ok) {
        expect(page3.returnedCount).toBe(2);
        expect(page3.totalCached).toBe(12);
        expect(page3.hasMore).toBe(false);
        expect(page3.results[0].title).toBe("Result 11");
        expect(page3.nextCursor).toBeUndefined();
      }

      // Replaying cursor 2 fails with cursor_expired
      const replay2 = store.next(cursor2);
      expect(replay2.ok).toBe(false);
      if (!replay2.ok) {
        expect(replay2.code).toBe("cursor_expired");
      }
    }
  });

  it("supports pageSize override on next without mutating subsequent calls", () => {
    const store = new SessionStore();
    const results = makeResults(15);
    const page1 = store.createSession({
      query: "override",
      results,
      enginesUsed: ["duckduckgo"],
      unresponsiveEngines: [],
      pageSize: 5,
    });
    const cursor1 = page1.nextCursor!;

    // Override page size to 3
    const page2 = store.next(cursor1, 3);
    expect(page2.ok).toBe(true);
    if (page2.ok) {
      expect(page2.returnedCount).toBe(3);
      const cursor2 = page2.nextCursor!;

      // Next call without override resumes default page size (5)
      const page3 = store.next(cursor2);
      expect(page3.ok).toBe(true);
      if (page3.ok) {
        expect(page3.returnedCount).toBe(5);
      }
    }
  });

  it("does not consume cursor on cancellation or invalid pageSize override", () => {
    const store = new SessionStore();
    const results = makeResults(10);
    const page1 = store.createSession({
      query: "test",
      results,
      enginesUsed: ["duckduckgo"],
      unresponsiveEngines: [],
      pageSize: 5,
    });
    const cursor = page1.nextCursor!;

    // 1. Cancelled call
    const ac = new AbortController();
    ac.abort();
    const cancelled = store.next(cursor, undefined, ac.signal);
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) {
      expect(cancelled.code).toBe("cancelled");
    }

    // Cursor must still be valid
    // 2. Invalid page size
    const invalid = store.next(cursor, 999);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.code).toBe("invalid_request");
    }

    // Cursor must still be valid for a successful next call
    const success = store.next(cursor);
    expect(success.ok).toBe(true);
    if (success.ok) {
      expect(success.returnedCount).toBe(5);
    }
  });

  it("expires snapshots and cursors after TTL", () => {
    const store = new SessionStore();
    const results = makeResults(10);
    let mockTime = 1000;

    const page1 = store.createSession(
      {
        query: "ttl",
        results,
        enginesUsed: ["duckduckgo"],
        unresponsiveEngines: [],
        pageSize: 5,
      },
      mockTime,
    );
    const cursor = page1.nextCursor!;

    // Advance time beyond 15 minutes
    mockTime += SNAPSHOT_TTL_MS + 10;

    const expired = store.next(cursor, undefined, undefined, mockTime);
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.code).toBe("cursor_expired");
    }
  });

  it("evicts oldest snapshot when reaching 33 snapshots", () => {
    const store = new SessionStore();
    const cursors: string[] = [];

    // Create 32 snapshots
    for (let i = 0; i < MAX_SNAPSHOTS; i++) {
      const page = store.createSession(
        {
          query: `query-${i}`,
          results: makeResults(10),
          enginesUsed: ["duckduckgo"],
          unresponsiveEngines: [],
          pageSize: 5,
        },
        1000 + i * 10,
      );
      cursors.push(page.nextCursor!);
    }
    expect(store.snapshotCount).toBe(32);

    // Create 33rd snapshot (oldest is query-0 at time 1000)
    const page33 = store.createSession(
      {
        query: "query-33",
        results: makeResults(10),
        enginesUsed: ["duckduckgo"],
        unresponsiveEngines: [],
        pageSize: 5,
      },
      2000,
    );
    expect(page33.ok).toBe(true);
    expect(store.snapshotCount).toBe(32);

    // Oldest cursor (from query-0) must now be evicted
    const evicted = store.next(cursors[0], undefined, undefined, 2000);
    expect(evicted.ok).toBe(false);
    if (!evicted.ok) {
      expect(evicted.code).toBe("cursor_expired");
    }

    // Second snapshot cursor should still work
    const stillValid = store.next(cursors[1], undefined, undefined, 2000);
    expect(stillValid.ok).toBe(true);
  });

  it("clears everything on dispose", () => {
    const store = new SessionStore();
    const page = store.createSession({
      query: "dispose",
      results: makeResults(10),
      enginesUsed: ["duckduckgo"],
      unresponsiveEngines: [],
      pageSize: 5,
    });
    expect(store.snapshotCount).toBe(1);
    expect(store.cursorCount).toBe(1);

    store.dispose();
    expect(store.snapshotCount).toBe(0);
    expect(store.cursorCount).toBe(0);

    const res = store.next(page.nextCursor!);
    expect(res.ok).toBe(false);
  });
});
