import { describe, expect, it } from "vitest";
import type { RoutingInventory, FolderCard } from "../files/routing-inventory";
import { bindFolderDecision, bindVaultRouting } from "./routing";
const garden: FolderCard = {
  id: "garden-id",
  aliases: ["garden"],
  kind: "obsidian",
  description: "",
  read: true,
  write: true,
  defaultSave: false,
  available: true,
  directories: [],
  truncated: false,
};
const inventory: RoutingInventory = {
  folders: [garden, { ...garden, id: "office-id", aliases: ["office"] }],
  generation: 1,
  refreshedAt: 1,
  truncated: false,
};
describe("trusted vault routing binding", () => {
  it("asks among unnamed vaults even when the model invents a valid alias", () => {
    expect(
      bindVaultRouting(
        { kind: "new", workflowId: "obsidian", targetHint: "garden" },
        "Put these meeting notes into a vault",
        inventory,
      ),
    ).toMatchObject({ kind: "clarify" });
  });
  it("binds the sole explicit alias and excludes partial alias matches", () => {
    expect(
      bindVaultRouting(
        { kind: "new", workflowId: "obsidian", targetHint: "garden" },
        "Save in office:/Inbox/Note.md",
        inventory,
      ),
    ).toMatchObject({ targetHint: "office-id" });
    expect(
      bindVaultRouting(
        { kind: "new", workflowId: "obsidian" },
        "Save in gardening",
        inventory,
      ),
    ).toMatchObject({ kind: "clarify" });
  });
  it("selects the sole configured vault without applying a generic default", () => {
    expect(
      bindVaultRouting(
        { kind: "new", workflowId: "obsidian" },
        "Save in a vault",
        { ...inventory, folders: [garden] },
      ),
    ).toMatchObject({ targetHint: "garden-id" });
    expect(
      bindVaultRouting(
        { kind: "new", workflowId: "commander" },
        "Save a normal file",
        inventory,
      ),
    ).toEqual({ kind: "new", workflowId: "commander" });
  });
});

const desktop: FolderCard = {
  ...garden,
  id: "desktop-id",
  aliases: ["desktop"],
  kind: "none",
  description: "",
  directories: ["agent-files"],
};
const desktopInventory: RoutingInventory = {
  folders: [desktop, garden],
  generation: 1,
  refreshedAt: 1,
  truncated: false,
};
describe("listed directory destinations", () => {
  it("binds a subdirectory hint to the parent folder", () => {
    expect(
      bindFolderDecision(
        { kind: "new", workflowId: "commander", targetHint: "agent-files" },
        "agent-files",
        desktopInventory,
      ),
    ).toMatchObject({ workflowId: "commander", targetHint: "desktop-id" });
    expect(
      bindFolderDecision(
        {
          kind: "new",
          workflowId: "commander",
          targetHint: "the 'agent-files' subfolder within it",
        },
        "the 'agent-files' subfolder within it",
        desktopInventory,
      ),
    ).toMatchObject({ targetHint: "desktop-id" });
  });
  it("selects the parent folder instead of asking folder versus subdirectory", () => {
    expect(
      bindFolderDecision(
        {
          kind: "clarify",
          question:
            "Which folder should I use for this operation: the 'desktop' folder or the 'agent-files' subfolder within it?",
        },
        "Move all files nested within subfolders on C:\\Users\\Leandro\\Desktop\\agent-files to the root of it",
        desktopInventory,
      ),
    ).toEqual({
      kind: "new",
      workflowId: "commander",
      targetHint: "desktop-id",
    });
  });
  it("keeps an alias and a different folder's directory ambiguous", () => {
    expect(
      bindFolderDecision(
        { kind: "clarify", question: "Which folder?" },
        "Save in office:/Inbox/Note.md",
        {
          ...inventory,
          folders: [
            ...inventory.folders,
            { ...desktop, directories: ["Inbox"] },
          ],
        },
      ),
    ).toMatchObject({ kind: "clarify" });
  });
  it("still rejects a hint that names no folder or listed directory", () => {
    expect(() =>
      bindFolderDecision(
        { kind: "new", workflowId: "commander", targetHint: "missing" },
        "missing",
        desktopInventory,
      ),
    ).toThrow(/target hint/u);
  });
});
