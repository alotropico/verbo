import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../shared/chat-ipc";
import { appendStoredMessage, loadThreadHistory } from "../db/history";
import { VERBO_MIGRATIONS, migrateDatabase } from "../db/migrate";
import {
  createTurnController,
  type Finalization,
  type TurnWork,
} from "./controller";
import { createTurnDispatcher } from "./turn-dispatcher";
import { liveById, requestTurnCancel } from "./turn-session";
import { recordTurnEvent } from "../db/turn-events";

function setup(
  work: TurnWork,
  save?: (final: Finalization) => void,
): {
  database: DatabaseSync;
  dispatcher: ReturnType<typeof createTurnDispatcher>;
  controller: {
    admitTurn: (
      envelope: Omit<import("./controller").TurnEnvelope, "turnId"> & {
        turnId?: string;
      },
      observe: (event: ChatEvent) => void,
    ) => { turnId: string; detach: () => void; completion: Promise<void> };
    retryFinalization: (
      identity: Pick<
        import("./controller").TurnEnvelope,
        "turnId" | "threadId" | "assistantMessageId"
      >,
    ) => Promise<boolean>;
    recoverFinalizations: () => void;
  };
  envelope: {
    turnId: string;
    threadId: string;
    userMessageId: string;
    assistantMessageId: string;
    source: "typed";
    admission: "immediate";
    text: string;
    attachmentIds: never[];
  };
} {
  const database = new DatabaseSync(":memory:");
  migrateDatabase(database, VERBO_MIGRATIONS);
  database
    .prepare(
      "INSERT INTO threads(id,title,created_at,updated_at) VALUES('thread','Test',1,1)",
    )
    .run();
  const dispatcher = createTurnDispatcher(database);
  const controller = createTurnController({
    database,
    dispatcher,
    work,
    save,
    retryDelays: [],
  });
  const envelope = {
    turnId: "turn",
    threadId: "thread",
    userMessageId: "user",
    assistantMessageId: "assistant",
    source: "typed" as const,
    admission: "immediate" as const,
    text: "Hello",
    attachmentIds: [],
  };
  return { database, dispatcher, controller, envelope };
}

describe("Controller terminal ownership", () => {
  it("regenerates conversation but reuses operational receipts without another execution", async () => {
    for (const operational of [false, true]) {
      const work = vi.fn<TurnWork>(async ({ emit }) => {
        if (operational)
          emit({
            type: "tool_result",
            toolCallId: "effect",
            name: "actions.invoke",
            args: { name: "files.create", args: {} },
            result: {
              action: "files.create",
              status: "success",
              summary: "Created once",
              receiptId: "stable-receipt",
            },
          });
        emit({ type: "delta", text: "Response" });
        return { stop: "completed" };
      });
      const fixture = setup(work);
      await fixture.controller.admitTurn(fixture.envelope, () => undefined)
        .completion;
      await fixture.controller.admitTurn(
        {
          ...fixture.envelope,
          turnId: "regenerated",
          assistantMessageId: "regenerated-assistant",
        },
        () => undefined,
      ).completion;
      expect(work).toHaveBeenCalledTimes(operational ? 1 : 2);
      const history = loadThreadHistory(fixture.database, "thread");
      expect(
        history.messages.filter((item) => item.message.role === "user"),
      ).toHaveLength(1);
      expect(history.headId).toBe("regenerated-assistant");
      if (operational)
        expect(
          history.messages.find(
            (item) => item.message.id === "regenerated-assistant",
          )?.message.content,
        ).toContainEqual(
          expect.objectContaining({
            type: "tool-call",
            result: expect.objectContaining({ receiptId: "stable-receipt" }),
          }),
        );
      await fixture.controller.admitTurn(fixture.envelope, () => undefined)
        .completion;
      expect(loadThreadHistory(fixture.database, "thread").headId).toBe(
        "regenerated-assistant",
      );
    }
  });
  it("parents promoted follow-ups after the persisted final on their selected branch", async () => {
    const fixture = setup(async ({ emit }) => {
      emit({ type: "delta", text: "Reply" });
      return { stop: "completed" };
    });
    await fixture.controller.admitTurn(fixture.envelope, () => undefined)
      .completion;
    await fixture.controller.admitTurn(
      {
        ...fixture.envelope,
        turnId: "next",
        userMessageId: "next-user",
        assistantMessageId: "next-assistant",
        branchAnchor: "user",
        admission: "promoted",
      },
      () => undefined,
    ).completion;
    const history = loadThreadHistory(fixture.database, "thread");
    expect(
      history.messages.find((item) => item.message.id === "next-user")
        ?.parentId,
    ).toBe("assistant");
  });
  it("persists the final before done, closes observation before promotion, and replays without work", async () => {
    const work = vi.fn<TurnWork>(async ({ emit }) => {
      emit({ type: "delta", text: "Saved answer" });
      return { stop: "completed" };
    });
    const { controller, dispatcher, database, envelope } = setup(work);
    const order: string[] = [];
    const first = controller.admitTurn(envelope, (event) => {
      if (event.type === "done") {
        expect(
          loadThreadHistory(database, "thread").messages.at(-1)?.message.id,
        ).toBe("assistant");
        order.push("saved");
      }
    });
    dispatcher.setOnPromoted(() => {
      expect(liveById("turn")).toBeNull();
      order.push("promoted");
    });
    dispatcher.enqueue({
      threadId: "thread",
      text: "Next",
      source: "typed",
      branchAnchor: "user",
    });
    await first.completion;
    expect(order).toEqual(["saved", "promoted"]);
    controller.admitTurn(envelope, () => undefined);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("holds a failed save visibly and shares repeated persistence-only retries", async () => {
    let failing = true;
    const work = vi.fn<TurnWork>(async ({ emit }) => {
      emit({ type: "delta", text: "Effect already finished" });
      return { stop: "completed" };
    });
    const save = vi.fn((final: Finalization) => {
      if (failing) throw new Error("disk full");
      appendStoredMessage(database, "thread", "user", {
        id: "assistant",
        role: "assistant",
        content: final.content,
      });
    });
    const setupResult = setup(work, save);
    const database = setupResult.database;
    const { controller, dispatcher, envelope } = setupResult;
    const events: ChatEvent[] = [];
    await controller.admitTurn(envelope, (event) => events.push(event))
      .completion;
    expect(events.at(-1)).toMatchObject({
      type: "finalization",
      state: "failed",
      message: "disk full",
    });
    expect(dispatcher.activeTurn()?.turnId).toBe("turn");
    expect(dispatcher.snapshot("thread").serviceHold).toContain("saving");
    const promoted = vi.fn();
    dispatcher.setOnPromoted(promoted);
    dispatcher.enqueue({
      threadId: "thread",
      text: "next",
      source: "typed",
      branchAnchor: "user",
    });
    expect(promoted).not.toHaveBeenCalled();
    failing = false;
    const retries = [
      controller.retryFinalization(envelope),
      controller.retryFinalization(envelope),
    ];
    expect(retries[0]).toBe(retries[1]);
    expect(await Promise.all(retries)).toEqual([true, true]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(work).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(promoted).toHaveBeenCalledTimes(1);
    expect(
      loadThreadHistory(database, "thread").messages.filter(
        (item) => item.message.role === "assistant",
      ),
    ).toHaveLength(1);
  });

  it("reattaches to one invocation and persists preparation cancellation before releasing", async () => {
    let release!: () => void;
    const work = vi.fn<TurnWork>(async ({ signal }) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      signal.throwIfAborted();
      return { stop: "completed" };
    });
    const { controller, envelope, dispatcher, database } = setup(work);
    const first = controller.admitTurn(envelope, () => undefined);
    controller.admitTurn(envelope, () => undefined);
    expect(work).toHaveBeenCalledTimes(1);
    requestTurnCancel("turn");
    expect(dispatcher.activeTurn()?.turnId).toBe("turn");
    release();
    await first.completion;
    expect(dispatcher.activeTurn()).toBeNull();
    expect(
      loadThreadHistory(database, "thread").messages.at(-1)?.message.role,
    ).toBe("assistant");
  });

  it("recovers pending presentation after restart without invoking the worker", async () => {
    const work = vi.fn<TurnWork>(async ({ emit }) => {
      emit({ type: "delta", text: "Frozen" });
      return { stop: "completed" };
    });
    const { controller, database, envelope } = setup(work, () => {
      throw new Error("unavailable");
    });
    await controller.admitTurn(envelope, () => undefined).completion;
    const dispatcher = createTurnDispatcher(database);
    const never = vi.fn<TurnWork>();
    const restarted = createTurnController({
      database,
      dispatcher,
      work: never,
      retryDelays: [],
    });
    restarted.recoverFinalizations();
    expect(await restarted.retryFinalization(envelope)).toBe(true);
    expect(never).not.toHaveBeenCalled();
    expect(
      loadThreadHistory(database, "thread").messages.at(-1)?.message.id,
    ).toBe("assistant");
  });
  it("serializes multiple recovered finalizations without promoting queued work between saves", async () => {
    const fixture = setup(
      async ({ emit }) => {
        emit({ type: "delta", text: "Frozen" });
        return { stop: "completed" };
      },
      () => {
        throw new Error("disk full");
      },
    );
    await fixture.controller.admitTurn(fixture.envelope, () => undefined)
      .completion;
    const final = JSON.parse(
      String(
        fixture.database
          .prepare(
            "SELECT payload_json FROM turn_events WHERE kind='finalization' ORDER BY seq DESC LIMIT 1",
          )
          .get()!.payload_json,
      ),
    ) as Finalization;
    const second = {
      ...final,
      envelope: {
        ...final.envelope,
        turnId: "second-turn",
        userMessageId: "second-user",
        assistantMessageId: "second-assistant",
      },
    };
    recordTurnEvent(fixture.database, {
      id: "second-pending",
      threadId: "thread",
      messageId: "second-assistant",
      turnId: "second-turn",
      seq: 1,
      kind: "finalization",
      payload: second,
    });
    const dispatcher = createTurnDispatcher(fixture.database);
    const work = vi.fn<TurnWork>();
    const restarted = createTurnController({
      database: fixture.database,
      dispatcher,
      work,
    });
    expect(() => restarted.recoverFinalizations()).not.toThrow();
    const promoted = vi.fn();
    dispatcher.setOnPromoted(promoted);
    dispatcher.enqueue({
      threadId: "thread",
      text: "Later",
      source: "typed",
      branchAnchor: "user",
    });
    const firstIdentity =
      dispatcher.activeTurn()?.turnId === "turn"
        ? fixture.envelope
        : second.envelope;
    const nextIdentity =
      firstIdentity.turnId === "turn" ? second.envelope : fixture.envelope;
    expect(await restarted.retryFinalization(firstIdentity)).toBe(true);
    expect(promoted).not.toHaveBeenCalled();
    expect(dispatcher.activeTurn()?.turnId).toBe(nextIdentity.turnId);
    expect(await restarted.retryFinalization(nextIdentity)).toBe(true);
    expect(promoted).toHaveBeenCalledTimes(1);
    expect(work).not.toHaveBeenCalled();
  });

  it("does not move a newer head after a lost save acknowledgement or renderer echo", async () => {
    const { database } = setup(async () => ({ stop: "completed" }));
    appendStoredMessage(database, "thread", undefined, {
      id: "user",
      role: "user",
      content: [],
    });
    appendStoredMessage(database, "thread", "user", {
      id: "assistant",
      role: "assistant",
      content: [],
    });
    appendStoredMessage(database, "thread", "assistant", {
      id: "newer",
      role: "user",
      content: [],
    });
    appendStoredMessage(database, "thread", "user", {
      id: "assistant",
      role: "assistant",
      content: [],
    });
    expect(loadThreadHistory(database, "thread").headId).toBe("newer");
  });
});
