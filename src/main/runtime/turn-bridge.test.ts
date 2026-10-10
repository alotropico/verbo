import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { acceptComposerSend, resetComposerSendIds } from "./turn-bridge";

describe("installed LocalRuntime ownership", () => {
  it("proves steer, self-dispatch, and a single in-run approval", () => {
    const output = execFileSync(
      process.execPath,
      ["src/main/runtime/local-runtime-probe.mjs"],
      {
        encoding: "utf8",
        timeout: 20000,
      },
    );
    const parsed = JSON.parse(output) as {
      failures: string[];
      evidence: {
        steerDuringRun: { steer: string[]; queue: string[] };
        queueLaneDispatchesItself: {
          runsBeforeRelease: number;
          runsAfterIdle: number;
        };
        unresolvedHumanTool: { runs: number };
        approvalStaysInOneRun: { runs: number; finished: boolean };
      };
    };
    expect(parsed.failures).toEqual([]);
    expect(parsed.evidence.steerDuringRun.steer).toEqual(["two"]);
    expect(parsed.evidence.queueLaneDispatchesItself.runsAfterIdle).toBe(2);
    expect(parsed.evidence.unresolvedHumanTool.runs).toBe(1);
    expect(parsed.evidence.approvalStaysInOneRun).toMatchObject({
      runs: 1,
      finished: true,
    });
  });
});

describe("main-owned composer send", () => {
  it("queues a follow-up without starting a second run", () => {
    resetComposerSendIds();
    const first = acceptComposerSend({
      busy: false,
      text: "one",
      persisted: [],
    });
    expect(first).toMatchObject({
      startRun: true,
      startedText: "one",
      persisted: [],
    });
    const second = acceptComposerSend({
      busy: true,
      text: "two",
      persisted: first.persisted,
    });
    expect(second.startRun).toBe(false);
    expect(second.persisted.map((item) => item.text)).toEqual(["two"]);
  });
});
