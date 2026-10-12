import type { DatabaseSync } from "node:sqlite";

export type VoiceDraftStore = {
  threadExists(threadId: string): boolean;
  read(threadId: string): string;
  write(threadId: string, text: string, now: number): void;
};

export function createVoiceDraftStore(database: DatabaseSync): VoiceDraftStore {
  return {
    threadExists(threadId: string): boolean {
      const row = database
        .prepare(`SELECT id FROM threads WHERE id = ?`)
        .get(threadId) as { id: string } | undefined;
      return row !== undefined;
    },
    read(threadId: string): string {
      const row = database
        .prepare(`SELECT text FROM voice_drafts WHERE thread_id = ?`)
        .get(threadId) as { text: string } | undefined;
      return row?.text ?? "";
    },
    write(threadId: string, text: string, now: number): void {
      const trimmed = text.trim();
      if (!trimmed) {
        database
          .prepare(`DELETE FROM voice_drafts WHERE thread_id = ?`)
          .run(threadId);
        return;
      }
      database
        .prepare(
          `INSERT INTO voice_drafts (thread_id, text, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             text = excluded.text,
             updated_at = excluded.updated_at`,
        )
        .run(threadId, trimmed, now);
    },
  };
}
