import { describe, expect, it } from "vitest";
import { resolveCTS } from "./cts";
import { withInvocation, permitsCommand } from "./policy";

describe("step CTS", () => {
  it("replaces configurable context without dropping host policy or raising ceilings", () => {
    const cts = resolveCTS({
      invocationId: "invocation",
      agentId: "commander",
      ceiling: { modules: ["files"], actions: [] },
      capabilities: { mode: "extend", modules: ["obsidian"] },
      step: {
        replace: ["selected"],
        instructions: "Operate only on the selected task.",
      },
      sources: [
        {
          id: "selected",
          text: "Scoped facts",
          audience: ["commander"],
          kind: "data",
        },
      ],
    });
    expect(cts.sourceIds).toEqual(["selected"]);
    expect(cts.instructions).toContain(
      "Host permissions and confirmations are immutable",
    );
    withInvocation(cts.policy, () => {
      expect(permitsCommand("files.create")).toBe(true);
      expect(permitsCommand("obsidian.create")).toBe(false);
    });
  });
  it("rejects another audience and cannot grant Writer tools", () => {
    expect(() =>
      resolveCTS({
        invocationId: "x",
        agentId: "writer",
        step: { include: ["other"] },
        ceiling: { modules: ["files"], actions: [] },
        sources: [
          {
            id: "other",
            text: "Private Commander text",
            audience: ["commander"],
            kind: "instructions",
          },
        ],
      }),
    ).toThrow("not assigned");
    const cts = resolveCTS({
      invocationId: "x",
      agentId: "writer",
      ceiling: { modules: ["files"], actions: [] },
      sources: [],
      capabilities: { mode: "replace", modules: ["files"] },
    });
    withInvocation(cts.policy, () =>
      expect(permitsCommand("files.create")).toBe(false),
    );
  });
});
