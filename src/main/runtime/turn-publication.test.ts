import { describe, expect, it } from "vitest";
import { runTurn, type TurnUpdate } from "./turn";
import { createRequestGate } from "./request-gate";

describe("backend publication gate", () => {
  it("withholds early and late tool-round text through continuation and persistence updates", async () => {
    const updates: TurnUpdate[] = [];
    const contexts: string[] = [];
    let round = 0;
    const outcome = await runTurn({
      userText: "What platform?",
      history: [],
      numCtx: 8192,
      context: { actor: "model", threadId: "gate-thread" },
      gate: createRequestGate(),
      onUpdate: (update) => updates.push(update),
      model: async (messages, hooks) => {
        contexts.push(JSON.stringify(messages));
        round += 1;
        if (round === 1) {
          hooks.onText("SECRET premature claim");
          expect(updates.some((update) => update.type === "text")).toBe(false);
          return [
            { message: { content: "SECRET premature claim" } },
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      index: 0,
                      name: "actions.invoke",
                      arguments: { name: "environment.platform", args: {} },
                    },
                  },
                ],
              },
            },
            { message: { content: "SECRET late claim" }, done: true },
          ];
        }
        expect(updates.some((update) => update.type === "tool_result")).toBe(
          true,
        );
        hooks.onText("Verified answer");
        expect(updates.some((update) => update.type === "text")).toBe(false);
        return [{ message: { content: "Verified answer" }, done: true }];
      },
    });
    expect(outcome.stop).toBe("completed");
    expect(outcome.content).toBe("Verified answer");
    expect(JSON.stringify(updates).includes("SECRET")).toBe(false);
    expect(contexts[1].includes("SECRET")).toBe(false);
    expect(updates.filter((update) => update.type === "text")).toEqual([
      { type: "text", text: "Verified answer" },
    ]);
  });

  it("never publishes or executes an incomplete invocation", async () => {
    const updates: TurnUpdate[] = [];
    const outcome = await runTurn({
      userText: "Hi",
      history: [],
      numCtx: 8192,
      context: { actor: "model", threadId: "gate-thread" },
      gate: createRequestGate(),
      onUpdate: (update) => updates.push(update),
      model: async (_messages, hooks) => {
        hooks.onText("Unfinished");
        return [{ message: { content: "Unfinished" }, done: false }];
      },
    });
    expect(outcome.stop).toBe("failed");
    expect(outcome.content).toBe("");
    expect(updates.some((update) => update.type === "text")).toBe(false);
  });
});
