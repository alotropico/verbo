import { z } from "zod";
import { persistedThreadIdSchema } from "./thread-identity";
import type { QueuedTurn } from "./turn-queue";
import { MAX_VOICE_TEXT_CHARS } from "./voice";

export const MAX_VOICE_DRAFT_CHARS = 8_000;
export const MAX_VOICE_SEGMENT_CHARS = 4_000;
export const MAX_SPOKEN_CHUNKS = 4;
export const SILENCE_SEND_MS = 1_000;

export type VoiceDraftView = {
  threadId: string;
  text: string;
};

export type VoiceDraftResult =
  | { ok: true; kind: "command"; name: "new" }
  | { ok: true; kind: "control"; name: "stop" | "cancel" }
  | { ok: true; kind: "ignored" }
  | {
      ok: true;
      kind: "composer";
      text: string;
      summary: string;
    }
  | { ok: true; kind: "draft"; draft: VoiceDraftView }
  | { ok: true; kind: "idle" }
  | { ok: true; kind: "submitted"; item: QueuedTurn; start: boolean }
  | { ok: false; summary: string };

const branchAnchorSchema = z.string().min(1).max(200).nullable();

export const voiceDraftReadSchema = z
  .object({
    threadId: persistedThreadIdSchema,
  })
  .strict();

export const voiceDraftSaveSchema = z
  .object({
    threadId: persistedThreadIdSchema,
    text: z.string().max(MAX_VOICE_DRAFT_CHARS),
  })
  .strict();

export const voiceDraftSendSchema = z
  .object({
    threadId: persistedThreadIdSchema,
    branchAnchor: branchAnchorSchema,
  })
  .strict();

export const voiceDraftCommitSchema = voiceDraftSendSchema
  .extend({
    text: z.string().trim().min(1).max(MAX_VOICE_SEGMENT_CHARS),
    captureMode: z.enum(["dictation", "control"]).default("dictation"),
  })
  .strict();

export function joinSpeech(existing: string, segment: string): string {
  const left = existing.trim();
  const right = segment.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
}

export function speechChunks(
  text: string,
  limit = MAX_VOICE_TEXT_CHARS,
  maxChunks = MAX_SPOKEN_CHUNKS,
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > 0 && chunks.length < maxChunks) {
    if (rest.length <= limit) {
      chunks.push(rest);
      break;
    }
    const window = rest.slice(0, limit);
    const breakAt = Math.max(
      window.lastIndexOf("\n"),
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! "),
    );
    const cut = breakAt > 200 ? breakAt + 1 : limit;
    const piece = rest.slice(0, cut).trim();
    if (!piece) break;
    chunks.push(piece);
    rest = rest.slice(cut).trim();
  }
  return chunks;
}

export function silenceSendDecision(input: {
  quietForMs: number | null;
  editing: boolean;
  modelRunning: boolean;
  hasDraft: boolean;
  silenceSendMs?: number;
}): "wait" | "hold" | "send" {
  const silenceSendMs = input.silenceSendMs ?? SILENCE_SEND_MS;
  if (input.quietForMs === null || input.editing || !input.hasDraft)
    return "hold";
  if (input.quietForMs < silenceSendMs) return "wait";
  if (input.modelRunning) return "hold";
  return "send";
}

export function voiceStatusLine(input: {
  active: boolean;
  capture: "idle" | "listening" | "transcribing";
  paused: boolean;
  speaking: boolean;
  error: string | null;
  hasDraft: boolean;
  modelRunning: boolean;
}): string {
  if (input.error) return input.error;
  if (input.speaking || input.paused) {
    return input.active ? "Speaking. Microphone paused." : "Speaking.";
  }
  if (!input.active) return input.hasDraft ? "Voice draft kept." : "";
  const model = input.modelRunning ? " Model working." : "";
  if (input.capture === "transcribing") return `Transcribing.${model}`;
  if (input.hasDraft) return `Listening. Voice draft waiting.${model}`;
  if (input.modelRunning) return "Listening. Model working.";
  return "Listening";
}

export function assistantPlainText(message: {
  role: string;
  content: readonly { type: string; text?: string }[];
}): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}
