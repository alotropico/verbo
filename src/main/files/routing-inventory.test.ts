import { describe, expect, it, vi } from "vitest";
import type { FileScopeRecord } from "../../shared/files";
import {
  createRoutingInventory,
  resolveVaultTarget,
} from "./routing-inventory";

const vault = (id: string): FileScopeRecord => ({
  id,
  alias: id,
  aliases: [id],
  path: `C:\\fixtures\\${id}`,
  read: true,
  write: true,
  defaultSave: false,
  kind: "obsidian",
  createdAt: 1,
  updatedAt: 1,
});
describe("routing inventory and trusted vault selection", () => {
  it("caches shallow metadata, invalidates on settings changes and exposes truncation", () => {
    let generation = 1;
    const scan = vi.fn(() => ({
      directories: ["Ideas", "Ideas/Inbox"],
      available: true,
      truncated: false,
    }));
    const inventory = createRoutingInventory({
      scopes: () => [vault("alpha"), vault("beta")],
      generation: () => generation,
      scan,
      maxFolders: 1,
    });
    expect(inventory.get()).toMatchObject({ truncated: true, generation: 1 });
    inventory.get();
    expect(scan).toHaveBeenCalledTimes(1);
    generation += 1;
    expect(inventory.get().generation).toBe(2);
    expect(scan).toHaveBeenCalledTimes(2);
  });
  it("selects a sole or explicitly named vault and never chooses an alphabetic default", () => {
    const one = vault("alpha"),
      two = vault("beta");
    expect(resolveVaultTarget([one])).toMatchObject({
      status: "selected",
      scope: { id: "alpha" },
    });
    expect(resolveVaultTarget([two, one])).toMatchObject({ status: "clarify" });
    expect(resolveVaultTarget([one, two], "beta")).toMatchObject({
      status: "selected",
      scope: { id: "beta" },
    });
    expect(resolveVaultTarget([one], "missing")).toMatchObject({
      status: "blocked",
    });
    expect(resolveVaultTarget([{ ...one, write: false }])).toMatchObject({
      status: "blocked",
    });
    expect(
      resolveVaultTarget([{ ...one, write: false }], undefined, "read"),
    ).toMatchObject({ status: "selected" });
  });
});
