import type { DatabaseSync } from "node:sqlite";
import { parseVoiceCommand } from "../../shared/local-commands";
import {
  joinSpeech,
  MAX_VOICE_DRAFT_CHARS,
  type VoiceDraftResult,
} from "../../shared/voice-draft";
import type { TurnDispatcher } from "../runtime/turn-dispatcher";
import { createVoiceDraftStore } from "../db/voice-drafts";

const missingThread = "That conversation is not saved yet.";
const emptyDraft = "The voice draft is empty.";
const fullDraft = "The voice draft is full. Send or discard it.";

export type VoiceDraftService = {
  read(threadId: string): VoiceDraftResult;
  commit(input: {
    threadId: string;
    text: string;
    branchAnchor: string | null;
  }): VoiceDraftResult;
  flush(input: {
    threadId: string;
    branchAnchor: string | null;
  }): VoiceDraftResult;
  save(input: { threadId: string; text: string }): VoiceDraftResult;
  discard(threadId: string): VoiceDraftResult;
  send(input: {
    threadId: string;
    branchAnchor: string | null;
  }): VoiceDraftResult;
};

export function createVoiceDraftService(
  database: DatabaseSync,
  dispatcher: TurnDispatcher,
): VoiceDraftService {
  const drafts = createVoiceDraftStore(database);

  function view(threadId: string, text: string): VoiceDraftResult {
    return { ok: true, kind: "draft", draft: { threadId, text } };
  }

  function submit(
    threadId: string,
    text: string,
    branchAnchor: string | null,
  ): VoiceDraftResult {
    const saved = dispatcher.enqueue({
      threadId,
      text,
      branchAnchor,
      source: "voice",
    });
    if (!saved.ok) return { ok: false, summary: saved.summary };
    drafts.write(threadId, "", Date.now());
    return {
      ok: true,
      kind: "submitted",
      item: saved.item,
      start: saved.start,
    };
  }

  return {
    read(threadId: string): VoiceDraftResult {
      if (!drafts.threadExists(threadId)) {
        return { ok: false, summary: missingThread };
      }
      return view(threadId, drafts.read(threadId));
    },
    commit(input): VoiceDraftResult {
      if (!drafts.threadExists(input.threadId)) {
        return { ok: false, summary: missingThread };
      }
      if (parseVoiceCommand(input.text).handled) {
        return { ok: true, kind: "command", name: "new" };
      }
      const joined = joinSpeech(drafts.read(input.threadId), input.text);
      if (joined.length > MAX_VOICE_DRAFT_CHARS) {
        return { ok: false, summary: fullDraft };
      }
      drafts.write(input.threadId, joined, Date.now());
      return view(input.threadId, joined);
    },
    flush(input): VoiceDraftResult {
      if (!drafts.threadExists(input.threadId)) {
        return { ok: false, summary: missingThread };
      }
      const text = drafts.read(input.threadId);
      if (!text) return { ok: true, kind: "idle" };
      if (!dispatcher.acceptsImmediate(input.threadId))
        return view(input.threadId, text);
      return submit(input.threadId, text, input.branchAnchor);
    },
    save(input): VoiceDraftResult {
      if (!drafts.threadExists(input.threadId)) {
        return { ok: false, summary: missingThread };
      }
      const text = input.text.trim();
      if (text.length > MAX_VOICE_DRAFT_CHARS) {
        return { ok: false, summary: fullDraft };
      }
      drafts.write(input.threadId, text, Date.now());
      return view(input.threadId, text);
    },
    discard(threadId: string): VoiceDraftResult {
      if (!drafts.threadExists(threadId)) {
        return { ok: false, summary: missingThread };
      }
      drafts.write(threadId, "", Date.now());
      return view(threadId, "");
    },
    send(input): VoiceDraftResult {
      if (!drafts.threadExists(input.threadId)) {
        return { ok: false, summary: missingThread };
      }
      const text = drafts.read(input.threadId);
      if (!text) return { ok: false, summary: emptyDraft };
      return submit(input.threadId, text, input.branchAnchor);
    },
  };
}
