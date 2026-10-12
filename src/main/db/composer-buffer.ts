import type { DatabaseSync } from "node:sqlite";
import { parseAttachmentRefs } from "../files/asset-store";
import type { AttachmentRef } from "../../shared/attachments";

export type ComposerBuffer = {
  text: string;
  attachmentRefs: AttachmentRef[];
};

export type ComposerBufferStore = {
  keep(
    threadId: string,
    text: string,
    attachmentRefs: AttachmentRef[],
    now: number,
  ): void;
  read(threadId: string): ComposerBuffer | null;
  take(threadId: string): ComposerBuffer;
};

export function createComposerBufferStore(
  database: DatabaseSync,
): ComposerBufferStore {
  return {
    read(threadId): ComposerBuffer | null {
      const row = database
        .prepare(
          `SELECT text, attachment_refs_json FROM composer_buffers WHERE thread_id = ?`,
        )
        .get(threadId) as
        { text: string; attachment_refs_json: string } | undefined;
      if (!row) return null;
      return {
        text: row.text,
        attachmentRefs: parseAttachmentRefs(row.attachment_refs_json),
      };
    },
    keep(threadId, text, attachmentRefs, now): void {
      const existing = database
        .prepare(`SELECT thread_id FROM composer_buffers WHERE thread_id = ?`)
        .get(threadId);
      if (existing) return;
      database
        .prepare(
          `INSERT INTO composer_buffers (thread_id, text, attachment_refs_json, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(threadId, text, JSON.stringify(attachmentRefs), now);
    },
    take(threadId): ComposerBuffer {
      const row = database
        .prepare(
          `SELECT text, attachment_refs_json FROM composer_buffers WHERE thread_id = ?`,
        )
        .get(threadId) as
        { text: string; attachment_refs_json: string } | undefined;
      database
        .prepare(`DELETE FROM composer_buffers WHERE thread_id = ?`)
        .run(threadId);
      if (!row) return { text: "", attachmentRefs: [] };
      return {
        text: row.text,
        attachmentRefs: parseAttachmentRefs(row.attachment_refs_json),
      };
    },
  };
}
