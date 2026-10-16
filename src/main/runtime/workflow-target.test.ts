import { describe, expect, it } from "vitest";
import type { FileScopeRecord } from "../../shared/files";
import { resolveWorkflowTarget } from "./workflow-target";

const scope: FileScopeRecord = {
  id: "folder",
  alias: "work",
  aliases: ["work"],
  path: "C:/fixture/work",
  read: true,
  write: true,
  defaultSave: true,
  kind: "none",
  createdAt: 1,
  updatedAt: 1,
};
describe("workflow target continuation", () => {
  it.each(["none", "obsidian"] as const)(
    "requires fresh confirmation for changed %s target and consumes it once",
    (kind) => {
      const original = { ...scope, kind };
      const first = resolveWorkflowTarget({
        scopes: [original],
        target: original.id,
        vault: kind === "obsidian",
      });
      const changed = {
        ...original,
        path: "C:/fixture/replacement",
        write: false,
      };
      const input = {
        scopes: [changed],
        target: original.id,
        prior: first.snapshot,
        vault: kind === "obsidian",
      };
      expect(resolveWorkflowTarget(input).question?.required).toBe(true);
      const confirmed = resolveWorkflowTarget({ ...input, answer: "work" });
      expect(confirmed.question).toBeUndefined();
      expect(confirmed.snapshot).toMatchObject({
        path: changed.path,
        write: false,
      });
      expect(
        resolveWorkflowTarget({ ...input, prior: confirmed.snapshot }).question,
      ).toBeUndefined();
      expect(
        resolveWorkflowTarget({
          ...input,
          scopes: [original],
          prior: confirmed.snapshot,
        }).question,
      ).toBeDefined();
    },
  );
  it("does not select a default folder when the retained target was removed or an alias was rebound", () => {
    const first = resolveWorkflowTarget({
      scopes: [scope],
      target: "work",
      vault: false,
    });
    expect(
      resolveWorkflowTarget({
        scopes: [{ ...scope, id: "replacement" }],
        target: scope.id,
        prior: first.snapshot,
        vault: false,
      }).scope,
    ).toBeUndefined();
    expect(
      resolveWorkflowTarget({
        scopes: [{ ...scope, id: "replacement" }],
        target: "work",
        prior: first.snapshot,
        vault: false,
      }).question,
    ).toBeDefined();
  });
  it("asks among multiple vaults and selects a sole vault without inventing a generic folder", () => {
    const vault = { ...scope, kind: "obsidian" as const };
    expect(
      resolveWorkflowTarget({ scopes: [vault], target: null, vault: true })
        .scope?.id,
    ).toBe(scope.id);
    expect(
      resolveWorkflowTarget({
        scopes: [vault, { ...vault, id: "other", alias: "other" }],
        target: null,
        vault: true,
      }).question,
    ).toBeDefined();
    expect(
      resolveWorkflowTarget({ scopes: [scope], target: null, vault: true })
        .scope,
    ).toBeUndefined();
    expect(
      resolveWorkflowTarget({ scopes: [scope], target: null, vault: false }),
    ).toEqual({});
  });
});
