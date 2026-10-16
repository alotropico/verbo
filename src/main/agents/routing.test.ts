import { describe, expect, it } from "vitest";
import type { RoutingInventory, FolderCard } from "../files/routing-inventory";
import { bindVaultRouting } from "./routing";
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
