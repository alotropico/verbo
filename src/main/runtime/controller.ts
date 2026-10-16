import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ChatEvent, ChatTurnStop } from "../../shared/chat-ipc";
import {
  emptyChatProjection,
  projectChatEvent,
  visibleProjection,
} from "../../shared/chat-projection";
import type { QueueSource } from "../../shared/turn-queue";
import { appendStoredMessage, assertTurnThread } from "../db/history";
import { recordTurnEvent, type TurnEventKind } from "../db/turn-events";
import type { TurnDispatcher } from "./turn-dispatcher";
import { activeInvocation } from "../agents/policy";
import {
  closeLiveTurn,
  liveById,
  liveEvents,
  openLiveTurn,
  publishLive,
  subscribeLive,
} from "./turn-session";

export type TurnEnvelope = {
  turnId: string;
  threadId: string;
  branchAnchor?: string;
  userMessageId: string;
  assistantMessageId: string;
  queueItemId?: string;
  source: QueueSource;
  admission: "immediate" | "promoted" | "resume";
  text: string;
  attachmentIds: string[];
  headAtAdmission?: string | null;
};

export const finalizationSchema = z
  .object({
    envelope: z
      .object({
        turnId: z.string(),
        threadId: z.string(),
        branchAnchor: z.string().optional(),
        userMessageId: z.string(),
        assistantMessageId: z.string(),
        queueItemId: z.string().optional(),
        source: z.enum(["typed", "voice"]),
        admission: z.enum(["immediate", "promoted", "resume"]),
        text: z.string(),
        attachmentIds: z.array(z.string()),
        headAtAdmission: z.string().nullable().optional(),
      })
      .strict(),
    content: z.array(z.unknown()),
    stop: z.enum([
      "completed",
      "paused",
      "cancelled",
      "limit",
      "capacity",
      "no_progress",
      "failed",
    ]),
    state: z.enum(["pending", "saved"]),
  })
  .strict();

export type Finalization = z.infer<typeof finalizationSchema>;
type Run = {
  envelope: TurnEnvelope;
  final?: Finalization;
  replay?: Finalization;
  retry?: Promise<boolean>;
  seq: number;
  emit: (event: ChatEvent) => void;
  persist: (kind: TurnEventKind, payload: unknown) => void;
};

export type TurnWork = (input: {
  envelope: TurnEnvelope;
  signal: AbortSignal;
  emit: (event: ChatEvent) => void;
  persist: (kind: TurnEventKind, payload: unknown) => void;
  checkpointPresentation: (text: string, stop: ChatTurnStop) => void;
}) => Promise<{ stop: ChatTurnStop; summary?: string }>;

/** The sole admission and terminal owner. Observers can detach without cancelling work. */
export function createTurnController(input: {
  database: DatabaseSync;
  dispatcher: TurnDispatcher;
  work: TurnWork;
  save?: (final: Finalization) => void;
  retryDelays?: number[];
}): {
  admitTurn: (
    envelope: Omit<TurnEnvelope, "turnId"> & { turnId?: string },
    observe: (event: ChatEvent) => void,
  ) => { turnId: string; detach: () => void; completion: Promise<void> };
  retryFinalization: (
    identity: Pick<TurnEnvelope, "turnId" | "threadId" | "assistantMessageId">,
  ) => Promise<boolean>;
  recoverFinalizations: () => void;
} {
  const runs = new Map<string, Run>();
  const { database, dispatcher } = input;
  const pendingFinalizations = (
    excludingTurnId = "",
  ): Record<string, import("node:sqlite").SQLOutputValue>[] =>
    database
      .prepare(
        `SELECT payload_json FROM turn_events AS pending
      WHERE kind='finalization' AND pending.turn_id<>? AND json_extract(payload_json,'$.state')='pending'
      AND NOT EXISTS(SELECT 1 FROM turn_events AS saved WHERE saved.turn_id=pending.turn_id
        AND saved.kind='finalization' AND json_extract(saved.payload_json,'$.state')='saved')
      ORDER BY created_at DESC,seq DESC`,
      )
      .all(excludingTurnId);
  const userContent = (envelope: TurnEnvelope): unknown[] => [
    { type: "text", text: envelope.text },
    ...envelope.attachmentIds.flatMap((id) => {
      const row = database
        .prepare(
          "SELECT name,media_type FROM attachments WHERE id=? AND thread_id=?",
        )
        .get(id, envelope.threadId);
      return row
        ? [
            {
              type: "file",
              sourceType: "id",
              data: id,
              filename: String(row.name),
              mimeType: String(row.media_type),
            },
          ]
        : [];
    }),
  ];
  const save =
    input.save ??
    ((final: Finalization): void => {
      database.exec("BEGIN IMMEDIATE");
      try {
        appendStoredMessage(
          database,
          final.envelope.threadId,
          final.envelope.branchAnchor,
          {
            id: final.envelope.userMessageId,
            role: "user",
            content: userContent(final.envelope),
          },
          "complete",
          final.envelope.branchAnchor ?? null,
        );
        const head = database
          .prepare("SELECT head_id FROM threads WHERE id=?")
          .get(final.envelope.threadId)?.head_id;
        const expectedHead =
          head === final.envelope.headAtAdmission
            ? final.envelope.headAtAdmission
            : final.envelope.userMessageId;
        appendStoredMessage(
          database,
          final.envelope.threadId,
          final.envelope.userMessageId,
          {
            id: final.envelope.assistantMessageId,
            role: "assistant",
            content: final.content,
          },
          "complete",
          expectedHead,
        );
        recordTurnEvent(database, {
          id: `${final.envelope.turnId}:saved`,
          threadId: final.envelope.threadId,
          messageId: final.envelope.assistantMessageId,
          turnId: final.envelope.turnId,
          seq: 2_000_001,
          kind: "finalization",
          payload: { ...final, state: "saved" },
        });
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });

  function retryFinalization(
    identity: Pick<TurnEnvelope, "turnId" | "threadId" | "assistantMessageId">,
  ): Promise<boolean> {
    const run = runs.get(identity.turnId);
    if (
      !run?.final ||
      run.envelope.threadId !== identity.threadId ||
      run.envelope.assistantMessageId !== identity.assistantMessageId
    )
      return Promise.resolve(false);
    if (run.retry) return run.retry;
    run.retry = Promise.resolve()
      .then(() => {
        try {
          // Frozen presentation only. This path has no access to the worker or command executor.
          run.persist("finalization", run.final);
          save(run.final!);
        } catch (error) {
          const message = (
            error instanceof Error ? error.message : "Storage unavailable"
          ).slice(0, 300);
          dispatcher.setServiceHold(
            "Response saving is paused. Retry saving response.",
          );
          run.emit({
            type: "finalization",
            turnId: identity.turnId,
            threadId: identity.threadId,
            assistantMessageId: identity.assistantMessageId,
            state: "failed",
            message,
          });
          return false;
        }
        run.emit({ type: "finalization", ...identity, state: "saved" });
        run.emit({ type: "done" });
        closeLiveTurn(identity.turnId);
        runs.delete(identity.turnId);
        // Close the old live mapping before synchronous promotion opens the next one.
        const remaining = pendingFinalizations(identity.turnId).length > 0;
        dispatcher.setServiceHold(
          remaining
            ? "Response saving is paused. Retry saving response."
            : null,
        );
        if (run.final!.stop === "cancelled")
          dispatcher.cancelIfRunning(identity.turnId);
        else if (run.final!.stop === "failed") dispatcher.fail(identity.turnId);
        else dispatcher.complete(identity.turnId);
        if (remaining) recoverFinalizations();
        return true;
      })
      .finally(() => {
        run.retry = undefined;
      });
    return run.retry;
  }

  async function runAdmittedTurn(run: Run): Promise<void> {
    let projection = emptyChatProjection();
    const originalEmit = run.emit;
    run.emit = (event) => {
      projection = projectChatEvent(projection, event);
      originalEmit(event);
    };
    let stop: ChatTurnStop = "failed";
    try {
      appendStoredMessage(
        database,
        run.envelope.threadId,
        run.envelope.branchAnchor,
        {
          id: run.envelope.userMessageId,
          role: "user",
          content: userContent(run.envelope),
        },
      );
      const result: { stop: ChatTurnStop; summary?: string } = run.replay
        ? (() => {
            replayFinal(run.replay!, (event) => {
              if (event.type !== "done" && event.type !== "turn_identity")
                run.emit(event);
            });
            return { stop: run.replay!.stop };
          })()
        : await input.work({
            envelope: run.envelope,
            signal: liveById(run.envelope.turnId)!.abort.signal,
            emit: (event) => run.emit(event),
            persist: run.persist,
            checkpointPresentation: (text, stop) => {
              const fallback = projectChatEvent(projection, {
                type: "delta",
                text,
              });
              run.persist("finalization", {
                envelope: run.envelope,
                content: visibleProjection(fallback),
                stop,
                state: "pending",
              });
            },
          });
      stop = result.stop;
      if (!visibleProjection(projection).some((part) => part.type === "text")) {
        const receipts = projection.parts.flatMap((part) =>
          part.type === "tool-call" && part.result ? [part.result.summary] : [],
        );
        run.emit({
          type: "delta",
          text:
            result.summary ||
            receipts.join("\n") ||
            "The turn finished without a written response.",
        });
      }
      run.emit({ type: "turn_status", stop });
    } catch (error) {
      stop = liveById(run.envelope.turnId)?.abort.signal.aborted
        ? "cancelled"
        : "failed";
      run.emit({
        type: "delta",
        text:
          stop === "cancelled"
            ? "You stopped this reply. Completed effects are retained in the receipts."
            : (error instanceof Error
                ? error.message
                : "The turn failed."
              ).slice(0, 500),
      });
      run.emit({ type: "turn_status", stop });
    }
    run.final = structuredClone({
      envelope: run.envelope,
      content: visibleProjection(projection),
      stop,
      state: "pending",
    });
    const live = liveById(run.envelope.turnId);
    if (live) live.finalizing = true;
    // Release inference/approval resources; keep the session solely for observation and storage retry.
    liveById(run.envelope.turnId)?.abort.abort();
    for (const delay of [0, ...(input.retryDelays ?? [100, 400])]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (await retryFinalization(run.envelope)) return;
    }
  }

  function admitTurn(
    envelope: Omit<TurnEnvelope, "turnId"> & { turnId?: string },
    observe: (event: ChatEvent) => void,
  ): { turnId: string; detach: () => void; completion: Promise<void> } {
    const normalized: TurnEnvelope = {
      ...envelope,
      turnId: envelope.turnId ?? randomUUID(),
    };
    if (normalized.admission === "promoted") {
      const head = database
        .prepare("SELECT head_id FROM threads WHERE id=?")
        .get(normalized.threadId)?.head_id;
      let cursor = typeof head === "string" ? head : undefined;
      const seen = new Set<string>();
      while (
        cursor &&
        cursor !== normalized.branchAnchor &&
        !seen.has(cursor)
      ) {
        seen.add(cursor);
        const row = database
          .prepare("SELECT parent_id FROM messages WHERE id=? AND thread_id=?")
          .get(cursor, normalized.threadId);
        cursor = typeof row?.parent_id === "string" ? row.parent_id : undefined;
      }
      if (
        (!normalized.branchAnchor || cursor === normalized.branchAnchor) &&
        typeof head === "string"
      )
        normalized.branchAnchor = head;
    }
    assertTurnThread(database, normalized.threadId, normalized.branchAnchor);
    for (const [id, role] of [
      [normalized.userMessageId, "user"],
      [normalized.assistantMessageId, "assistant"],
    ]) {
      const row = database
        .prepare("SELECT thread_id,role FROM messages WHERE id=?")
        .get(id!);
      if (row && (row.thread_id !== normalized.threadId || row.role !== role))
        throw new Error(
          "Message identity belongs to another conversation or role.",
        );
    }
    normalized.headAtAdmission = database
      .prepare("SELECT head_id FROM threads WHERE id=?")
      .get(normalized.threadId)?.head_id as string | null;
    const existingRun = [...runs.values()].find(
      (run) =>
        run.envelope.threadId === normalized.threadId &&
        run.envelope.assistantMessageId === normalized.assistantMessageId,
    );
    if (existingRun) {
      for (const event of liveEvents(existingRun.envelope.turnId))
        observe(event);
      return {
        turnId: existingRun.envelope.turnId,
        detach: subscribeLive(existingRun.envelope.turnId, observe),
        completion: Promise.resolve(),
      };
    }
    const saved = database
      .prepare(
        "SELECT payload_json FROM turn_events WHERE thread_id=? AND kind='finalization' AND json_extract(payload_json,'$.state')='saved' AND (message_id=? OR json_extract(payload_json,'$.envelope.queueItemId')=?) LIMIT 1",
      )
      .get(
        normalized.threadId,
        normalized.assistantMessageId,
        normalized.queueItemId ?? null,
      );
    if (saved) {
      const final = finalizationSchema.parse(
        JSON.parse(String(saved.payload_json)),
      );
      replayFinal(final, observe);
      return {
        turnId: final.envelope.turnId,
        detach: () => undefined,
        completion: Promise.resolve(),
      };
    }
    const prior = database
      .prepare(
        "SELECT payload_json FROM turn_events WHERE thread_id=? AND kind='finalization' AND json_extract(payload_json,'$.state')='saved' AND json_extract(payload_json,'$.envelope.userMessageId')=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(normalized.threadId, normalized.userMessageId);
    const previousFinal = prior
      ? finalizationSchema.parse(JSON.parse(String(prior.payload_json)))
      : undefined;
    const begun = dispatcher.begin({
      threadId: normalized.threadId,
      turnId: normalized.turnId,
      ...(normalized.queueItemId
        ? { queueItemId: normalized.queueItemId }
        : {}),
    });
    if (!begun.ok) throw new Error(begun.summary);
    if (begun.attached && begun.turnId) {
      const live = liveById(begun.turnId);
      if (live?.userMessageId)
        observe({
          type: "turn_identity",
          turnId: live.turnId,
          threadId: live.threadId,
          userMessageId: live.userMessageId,
          assistantMessageId: live.assistantMessageId,
        });
      for (const event of liveEvents(begun.turnId)) observe(event);
      return {
        turnId: begun.turnId,
        detach: subscribeLive(begun.turnId, observe),
        completion: Promise.resolve(),
      };
    }
    openLiveTurn({
      turnId: normalized.turnId,
      threadId: normalized.threadId,
      queueItemId: normalized.queueItemId ?? null,
      userMessageId: normalized.userMessageId,
      assistantMessageId: normalized.assistantMessageId,
      userText: normalized.text,
      operationId: null,
      abort: new AbortController(),
    });
    const run: Run = {
      envelope: normalized,
      seq: 0,
      ...(previousFinal?.content.some(
        (part) =>
          part &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "tool-call",
      )
        ? { replay: previousFinal }
        : {}),
      emit: (event) => publishLive(normalized.turnId, event),
      persist: (kind, payload) => {
        run.seq += 1;
        recordTurnEvent(database, {
          id: `${normalized.turnId}:${run.seq}`,
          threadId: normalized.threadId,
          messageId: normalized.assistantMessageId,
          turnId: normalized.turnId,
          seq: run.seq,
          kind,
          payload,
          attribution: activeInvocation()?.attribution,
        });
      },
    };
    runs.set(normalized.turnId, run);
    const detach = subscribeLive(normalized.turnId, observe);
    run.emit({
      type: "turn_identity",
      turnId: normalized.turnId,
      threadId: normalized.threadId,
      userMessageId: normalized.userMessageId,
      assistantMessageId: normalized.assistantMessageId,
    });
    const completion = runAdmittedTurn(run);
    return { turnId: normalized.turnId, detach, completion };
  }

  function recoverFinalizations(): void {
    if (runs.size) return;
    const pending = pendingFinalizations();
    const recovered = new Set<string>();
    for (const row of pending) {
      const parsed = finalizationSchema.safeParse(
        JSON.parse(String(row.payload_json)),
      );
      if (!parsed.success || recovered.has(parsed.data.envelope.turnId))
        continue;
      const final = parsed.data;
      recovered.add(final.envelope.turnId);
      const envelope = final.envelope;
      dispatcher.restoreFinalization(envelope);
      openLiveTurn({
        ...envelope,
        queueItemId: envelope.queueItemId ?? null,
        userText: envelope.text,
        operationId: null,
        abort: new AbortController(),
        finalizing: true,
      });
      const last = database
        .prepare(
          "SELECT MAX(seq) AS seq FROM turn_events WHERE turn_id=? AND seq<2000000",
        )
        .get(envelope.turnId);
      const run: Run = {
        envelope,
        final,
        seq: Number(last?.seq ?? 0),
        emit: (event) => publishLive(envelope.turnId, event),
        persist: (kind, payload) => {
          run.seq += 1;
          recordTurnEvent(database, {
            id: `${envelope.turnId}:${run.seq}`,
            threadId: envelope.threadId,
            messageId: envelope.assistantMessageId,
            turnId: envelope.turnId,
            seq: run.seq,
            kind,
            payload,
          });
        },
      };
      runs.set(envelope.turnId, run);
      replayFinal(final, (event) => {
        if (event.type !== "done") run.emit(event);
      });
      run.emit({
        type: "finalization",
        turnId: envelope.turnId,
        threadId: envelope.threadId,
        assistantMessageId: envelope.assistantMessageId,
        state: "failed",
        message: "A saved result is awaiting final response persistence.",
      });
      dispatcher.setServiceHold(
        "Response saving is paused. Retry saving response.",
      );
      // One foreground slot: retain any further pending snapshots durably until this save settles.
      break;
    }
  }

  return { admitTurn, retryFinalization, recoverFinalizations };
}

function replayFinal(
  final: Finalization,
  observe: (event: ChatEvent) => void,
): void {
  observe({
    type: "turn_identity",
    turnId: final.envelope.turnId,
    threadId: final.envelope.threadId,
    userMessageId: final.envelope.userMessageId,
    assistantMessageId: final.envelope.assistantMessageId,
  });
  const parsed = final.content as ReturnType<typeof visibleProjection>;
  for (const part of parsed) {
    if (part.type === "text") observe({ type: "delta", text: part.text });
    if (part.type === "tool-call" && part.result)
      observe({
        type: "tool_result",
        toolCallId: part.toolCallId,
        name: part.toolName,
        args: part.args,
        result: part.result,
      });
    if (part.type === "data" && part.name === "backend-notice")
      observe({ type: "backend_notice", notice: part.data });
    if (part.type === "data" && part.name === "workflow-stage")
      observe({ type: "stage", stage: part.data });
    if (part.type === "data" && part.name === "routing-stage")
      observe({ type: "routing_stage", stage: part.data });
    if (part.type === "data" && part.name === "workflow-execution")
      observe({ type: "execution", execution: part.data });
  }
  observe({ type: "done" });
}
