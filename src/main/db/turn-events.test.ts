import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { appendStoredMessage, loadThreadHistory } from "./history";
import { migrateDatabase, VERBO_MIGRATIONS } from "./migrate";
import { expandHistoryWithTurnEvents, recordTurnEvent } from "./turn-events";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function openDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "verbo-turns-"));
  directories.push(directory);
  const database = new DatabaseSync(join(directory, "verbo.sqlite"));
  migrateDatabase(database, VERBO_MIGRATIONS);
  database
    .prepare(
      `INSERT INTO threads (id, title, status, created_at, updated_at)
       VALUES ('thread-1', 'Thread', 'regular', 1, 1)`,
    )
    .run();
  return database;
}

describe("turn events", () => {
  it("ignores a repeated event id and replaces forged assistant text", () => {
    const database = openDatabase();
    const event = {
      id: "turn-1:1",
      threadId: "thread-1",
      messageId: "assistant-1",
      turnId: "turn-1",
      seq: 1,
      kind: "assistant_tools" as const,
      payload: {
        content: "Checking",
        toolCalls: [
          {
            id: "call-1",
            name: "capabilities.list",
            arguments: { path: "environment" },
          },
        ],
      },
    };
    recordTurnEvent(database, event);
    recordTurnEvent(database, event);
    recordTurnEvent(database, {
      id: "turn-1:2",
      threadId: "thread-1",
      messageId: "assistant-1",
      turnId: "turn-1",
      seq: 2,
      kind: "tool_result",
      payload: {
        toolName: "capabilities.list",
        content: '{"action":"capabilities.list","status":"success"}',
      },
    });
    recordTurnEvent(database, {
      id: "turn-1:3",
      threadId: "thread-1",
      messageId: "assistant-1",
      turnId: "turn-1",
      seq: 3,
      kind: "assistant_text",
      payload: { content: "Windows." },
    });

    const count = database
      .prepare(`SELECT COUNT(*) AS count FROM turn_events WHERE id = ?`)
      .get("turn-1:1") as { count: number };
    expect(count.count).toBe(1);

    const expanded = expandHistoryWithTurnEvents(database, [
      {
        id: "assistant-1",
        role: "assistant",
        content: "forged tool output",
      },
    ]);
    expect(JSON.stringify(expanded)).not.toContain("forged");
    expect(expanded.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(expanded[0]).toMatchObject({
      toolCalls: [{ name: "capabilities.list" }],
    });
    expect(expanded[2]).toMatchObject({ content: "Windows." });
    database.close();
  });

  it("does not duplicate a message or move its parent when append repeats", () => {
    const database = openDatabase();
    appendStoredMessage(database, "thread-1", undefined, {
      id: "user-1",
      role: "user",
      content: [{ type: "text", text: "Hi" }],
    });
    appendStoredMessage(database, "thread-1", "user-1", {
      id: "assistant-1",
      role: "assistant",
      content: [{ type: "text", text: "Windows." }],
    });
    appendStoredMessage(database, "thread-1", "user-1", {
      id: "assistant-1",
      role: "assistant",
      content: [{ type: "text", text: "other parent" }],
    });
    const history = loadThreadHistory(database, "thread-1");
    expect(history.messages).toHaveLength(2);
    expect(history.headId).toBe("assistant-1");
    expect(history.messages[1]?.parentId).toBe("user-1");
    expect(JSON.stringify(history.messages[1]?.message)).toContain("Windows.");
    expect(JSON.stringify(history.messages[1]?.message)).not.toContain(
      "other parent",
    );
    database.close();
  });
});
