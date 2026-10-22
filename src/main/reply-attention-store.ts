import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { replyAttentionStates } from "../shared/reply-attention";
import { persistedThreadIdSchema } from "../shared/thread-identity";

const unreadReplySchema = z.object({
  turnId: z.string().min(1).max(128),
  threadId: persistedThreadIdSchema,
  state: z.enum(replyAttentionStates),
});
export type UnreadReply = z.infer<typeof unreadReplySchema>;
export type ReplyAttentionStore = {
  load: () => UnreadReply[];
  save: (replies: UnreadReply[]) => void;
};

/** Notification metadata only; conversation storage and messages stay untouched. */
export function createReplyAttentionStore(filePath: string): ReplyAttentionStore {
  let lastSaved: string | undefined;
  return {
    load() {
      try {
        const replies = z.array(unreadReplySchema).parse(JSON.parse(readFileSync(filePath, "utf8")));
        lastSaved = JSON.stringify(replies);
        return replies;
      } catch {
        return [];
      }
    },
    save(replies) {
      const json = JSON.stringify(replies);
      if (json === lastSaved) return;
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(`${filePath}.tmp`, json, "utf8");
        renameSync(`${filePath}.tmp`, filePath);
        lastSaved = json;
      } catch {
        // Failure to retain attention must not interfere with reply delivery.
      }
    },
  };
}
