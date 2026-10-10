import { DatabaseSync } from "node:sqlite";

export type V1FixtureMessage = {
  rowId: string;
  parentRowId: string | null;
  role: "user" | "assistant";
  contentId: string;
  text: string;
  createdAt: number;
};

export type V1FixtureThread = {
  id: string;
  title: string;
  status: "regular" | "archived";
  messages: V1FixtureMessage[];
  /** Newest created_at row. v1 has no selected-head column, so reload uses this. */
  headRowId: string;
};

export type V1Fixture = {
  threads: V1FixtureThread[];
};

const SCHEMA = `
  CREATE TABLE schema_version (version INTEGER NOT NULL);
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'regular',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    parent_id TEXT,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'complete',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_messages_thread ON messages(thread_id);
  INSERT INTO schema_version(version) VALUES (1);
`;

function content(message: V1FixtureMessage): string {
  return JSON.stringify({
    id: message.contentId,
    role: message.role,
    content: [{ type: "text", text: message.text }],
    createdAt: new Date(message.createdAt).toISOString(),
  });
}

export function representativeV1Fixture(): V1Fixture {
  const notes: V1FixtureMessage[] = [
    {
      rowId: "row-notes-user-1",
      parentRowId: null,
      role: "user",
      contentId: "msg-notes-user-1",
      text: "What is a jaguar?",
      createdAt: 1_700_000_000_000,
    },
    {
      rowId: "row-notes-assistant-1",
      parentRowId: "row-notes-user-1",
      role: "assistant",
      contentId: "msg-notes-assistant-1",
      text: "A big cat.",
      createdAt: 1_700_000_000_100,
    },
    {
      rowId: "row-notes-user-1b",
      parentRowId: null,
      role: "user",
      contentId: "msg-notes-user-1b",
      text: "What is a jaguar in the notes?",
      createdAt: 1_700_000_000_200,
    },
    {
      rowId: "row-notes-assistant-1b",
      parentRowId: "row-notes-user-1b",
      role: "assistant",
      contentId: "msg-notes-assistant-1b",
      text: "A note about the animal.",
      createdAt: 1_700_000_000_300,
    },
    {
      rowId: "row-notes-user-2",
      parentRowId: "row-notes-assistant-1b",
      role: "user",
      contentId: "msg-notes-user-2",
      text: "Save that.",
      createdAt: 1_700_000_000_400,
    },
    {
      rowId: "row-notes-assistant-2",
      parentRowId: "row-notes-user-2",
      role: "assistant",
      contentId: "msg-notes-assistant-2",
      text: "Saved.",
      createdAt: 1_700_000_000_500,
    },
  ];

  const regen: V1FixtureMessage[] = [
    {
      rowId: "row-regen-user",
      parentRowId: null,
      role: "user",
      contentId: "msg-regen-user",
      text: "Name one color.",
      createdAt: 1_700_000_100_000,
    },
    {
      rowId: "row-regen-assistant-1",
      parentRowId: "row-regen-user",
      role: "assistant",
      contentId: "msg-regen-assistant-1",
      text: "Blue.",
      createdAt: 1_700_000_100_100,
    },
    {
      rowId: "row-regen-assistant-2",
      parentRowId: "row-regen-user",
      role: "assistant",
      contentId: "msg-regen-assistant-2",
      text: "Green.",
      createdAt: 1_700_000_100_200,
    },
  ];

  const archived: V1FixtureMessage[] = [
    {
      rowId: "row-archive-user",
      parentRowId: null,
      role: "user",
      contentId: "msg-archive-user",
      text: "Old question",
      createdAt: 1_699_000_000_000,
    },
    {
      rowId: "row-archive-assistant",
      parentRowId: "row-archive-user",
      role: "assistant",
      contentId: "msg-archive-assistant",
      text: "Old answer",
      createdAt: 1_699_000_000_100,
    },
  ];

  return {
    threads: [
      {
        id: "thread-notes",
        title: "Field notes",
        status: "regular",
        messages: notes,
        headRowId: "row-notes-assistant-2",
      },
      {
        id: "thread-regen",
        title: "Color",
        status: "regular",
        messages: regen,
        headRowId: "row-regen-assistant-2",
      },
      {
        id: "thread-archive",
        title: "Archived chat",
        status: "archived",
        messages: archived,
        headRowId: "row-archive-assistant",
      },
    ],
  };
}

export function createV1Database(
  database: DatabaseSync,
  fixture = representativeV1Fixture(),
): V1Fixture {
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(SCHEMA);
  const insertThread = database.prepare(
    `INSERT INTO threads (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertMessage = database.prepare(
    `INSERT INTO messages (id, thread_id, parent_id, role, content_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'complete', ?)`,
  );
  for (const thread of fixture.threads) {
    const createdAt = thread.messages[0]?.createdAt ?? 0;
    const updatedAt = thread.messages.at(-1)?.createdAt ?? createdAt;
    insertThread.run(
      thread.id,
      thread.title,
      thread.status,
      createdAt,
      updatedAt,
    );
    for (const message of thread.messages) {
      insertMessage.run(
        message.rowId,
        thread.id,
        message.parentRowId,
        message.role,
        content(message),
        message.createdAt,
      );
    }
  }
  return fixture;
}

export type StoredV1Message = V1FixtureMessage & { threadId: string };

export function readV1Messages(database: DatabaseSync): StoredV1Message[] {
  const rows = database
    .prepare(
      `SELECT id, thread_id, parent_id, role, content_json, created_at
       FROM messages ORDER BY created_at ASC`,
    )
    .all() as {
    id: string;
    thread_id: string;
    parent_id: string | null;
    role: string;
    content_json: string;
    created_at: number;
  }[];
  return rows.map((row) => {
    const parsed = JSON.parse(row.content_json) as {
      id: string;
      content: { text: string }[];
    };
    return {
      threadId: row.thread_id,
      rowId: row.id,
      parentRowId: row.parent_id,
      role: row.role === "user" ? "user" : "assistant",
      contentId: parsed.id,
      text: parsed.content[0]?.text ?? "",
      createdAt: row.created_at,
    };
  });
}
