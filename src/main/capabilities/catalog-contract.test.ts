import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  filesEditArgsSchema,
  filesBatchArgsSchema,
} from "../../shared/file-mutation";
import { createProductionRegistry } from "./catalog";

describe("production command compatibility", () => {
  it("preserves the shipped IDs, schemas, defaults and approval contracts", () => {
    const registry = createProductionRegistry();
    const ids = registry
      .list()
      .children.flatMap((module) =>
        registry.list(module.id).children.map((command) => command.id),
      );
    const additive = new Set([
      "projects.resolve",
      "projects.open",
      "software.resolve",
      "software.launch",
    ]);
    const shippedIds = ids.filter(
      (id) =>
        !id.startsWith("web.") &&
        !id.startsWith("obsidian.") &&
        !additive.has(id),
    );
    const contracts = shippedIds.flatMap(
      (id) => registry.describe([id]).entries,
    );
    expect(shippedIds).toHaveLength(33);
    // The current snapshot records the approved removal of folder depth. All other
    // shipped query fields and command contracts retain the captured baseline.
    for (const id of [
      "files.list",
      "files.search",
      "files.summary",
      "projects.files",
    ]) {
      const contract = contracts.find((entry) => entry.id === id)!;
      const schema = z
        .object({ properties: z.record(z.string(), z.unknown()) })
        .parse(contract.args);
      expect(schema.properties).not.toHaveProperty("depth");
      expect(contract.syntax).not.toContain("depth?");
      expect(contract.example).not.toHaveProperty("depth");
    }
    // Project the explicitly approved additive batch edit back onto its original
    // contract. Create/transfer/trash still match the captured snapshot exactly.
    const compatible = contracts.map((contract) => {
      if (contract.id !== "files.batch") return contract;
      const args = z
        .object({
          properties: z
            .object({
              items: z
                .object({
                  items: z
                    .object({
                      anyOf: z.array(
                        z
                          .object({
                            properties: z
                              .object({
                                action: z
                                  .object({ const: z.string().optional() })
                                  .passthrough(),
                              })
                              .passthrough(),
                          })
                          .passthrough(),
                      ),
                    })
                    .passthrough(),
                })
                .passthrough(),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(contract.args);
      const variants = args.properties.items.items.anyOf;
      const edits = variants.filter(
        (variant) => variant.properties.action.const === "files.edit",
      );
      expect(variants).toHaveLength(4);
      expect(edits).toHaveLength(1);
      const expectedEdit = z.toJSONSchema(
        filesEditArgsSchema.safeExtend({ action: z.literal("files.edit") }),
      );
      delete expectedEdit.$schema;
      expect(edits[0]).toEqual(expectedEdit);
      expect(contract.description).toContain(
        "create, edit, copy, move, rename, and trash",
      );
      expect(contract.syntax).toContain('action:"files.edit"');
      args.properties.items.items.anyOf = variants.filter(
        (variant) => variant.properties.action.const !== "files.edit",
      );
      return {
        ...contract,
        args,
        description:
          "Plan an ordered list of create, copy, move, rename, and trash items. A directory create can satisfy a later move. Any trash, or two or more items, waits for confirmation. Edits are separate one-file plans. Execution stops on the first failure.",
        syntax:
          '{items:[{action:"files.create", path, kind:"file"|"directory", content?, format?:"text"|"json"|"markdown"} | {action:"files.copy"|"files.move"|"files.rename", from, to} | {action:"files.trash", path}]}',
      };
    });
    expect(compatible).toMatchSnapshot();
    expect(
      filesBatchArgsSchema.safeParse({
        items: [
          {
            action: "files.edit",
            path: "tmp:/note.md",
            mode: "replace",
            find: "old",
          },
        ],
      }).success,
    ).toBe(false);
    if (process.env.VERBO_CAPTURE_COMMAND_BASELINE === "1") {
      writeFileSync(
        ".tmp/scratch/2026-10-12-command-registry-baseline.json",
        JSON.stringify(contracts, null, 2),
      );
    }
  });
});
