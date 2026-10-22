import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_SETTINGS } from "../../shared/config";
import { resolveCTS } from "./cts";
import { withInvocation, permitsCommand } from "./policy";
import { AGENT_PROFILES, resolveModelProfile } from "./profiles";

describe("step CTS", () => {
  it("allows all registered Commander modules, including scoped Obsidian operations", () => {
    const modules = ["environment", "files", "projects", "software", "ags", "memory", "obsidian"];
    const cts = resolveCTS({ invocationId: "scoped-writes", agentId: "commander", ceiling: { modules, actions: [] }, sources: [] });
    withInvocation(cts.policy, () => {
      for (const action of [
        "files.create",
        "files.edit",
        "obsidian.read",
        "obsidian.create",
        "obsidian.edit",
        "obsidian.move",
        "obsidian.rename",
        "obsidian.delete",
      ])
        expect(permitsCommand(action)).toBe(true);
      expect(permitsCommand("obsidian.eval")).toBe(false);
    });
  });
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
    expect(cts.instructions).toContain("Host permissions and confirmations are immutable");
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
    withInvocation(cts.policy, () => expect(permitsCommand("files.create")).toBe(false));
  });
  it("retains empty data sources in sourceIds but omits empty headers from instructions", () => {
    const cts = resolveCTS({
      invocationId: "empty-source-test",
      agentId: "conversational",
      ceiling: { modules: [], actions: [] },
      sources: [
        {
          id: "dialogue",
          text: "Workspace summary details",
          audience: ["conversational"],
          kind: "instructions",
        },
        {
          id: "attachments",
          text: "   ",
          audience: ["conversational"],
          kind: "data",
        },
        {
          id: "notes.conversational",
          text: "",
          audience: ["conversational"],
          kind: "data",
        },
      ],
    });
    expect(cts.sourceIds).toEqual(["dialogue", "attachments", "notes.conversational"]);
    expect(cts.instructions).toContain("Assigned guidance (dialogue):\nWorkspace summary details");
    expect(cts.instructions).not.toContain("Untrusted task data (attachments)");
    expect(cts.instructions).not.toContain("Untrusted task data (notes.conversational)");
  });
  it("verifies conversational agent profile instructions and model profile settings", () => {
    const instructions = AGENT_PROFILES.conversational.instructions;
    expect(instructions).toContain("You are Verbo");
    expect(instructions).toContain("conversational");
    expect(instructions).toContain("commander");
    expect(instructions).toContain("obsidian");
    expect(instructions).not.toContain("Execution honesty boundary");
    expect(instructions).toContain("Progressive depth");
    const { settings } = resolveModelProfile("conversational", DEFAULT_CHAT_SETTINGS);
    expect(settings.think).toBe(false);
  });
});
