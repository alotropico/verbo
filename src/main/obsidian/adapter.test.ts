import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  obsidianOperations,
  type ObsidianQualification,
} from "../../shared/obsidian";
import type { FileScopeRecord } from "../../shared/files";
import { createModuleRegistry } from "../capabilities/modules";
import { createPreparationOwner } from "../capabilities/preparation";
import { obsidianBindings, obsidianModule } from "../capabilities/obsidian";
import { createInvocationPolicy, withInvocation } from "../agents/policy";
import { VERBO_MIGRATIONS, migrateDatabase } from "../db/migrate";
import {
  applicationIdentity,
  createObsidianAdapter,
  executableIdentity,
  type ObsidianAdapterOptions,
} from "./adapter";
import { collectCommandResources } from "../files/resource-events";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(): {
  options: ObsidianAdapterOptions;
  root: string;
  runner: import("vitest").Mock<
    (input: {
      executable: string;
      args: string[];
      cwd: string;
      timeoutMs: number;
      signal?: AbortSignal;
      windowsVerbatimArguments?: boolean;
    }) => Promise<import("../capabilities/process").ProcessOutcome>
  >;
  qualification: {
    adapterVersion: 1;
    executableIdentity: string;
    applicationIdentity: string;
    appVersion: string;
    qualifiedAt: number;
    enabled: boolean;
    evidence: string;
    operations: Record<
      "read" | "create" | "edit" | "move" | "rename" | "delete",
      { supported: boolean; reason: string }
    >;
    passthrough: boolean;
  };
  scope: FileScopeRecord;
  directory: string;
} {
  const directory = mkdtempSync(
    join(process.cwd(), ".tmp", "scratch", "2026-10-15-obsidian-unit-"),
  );
  directories.push(directory);
  const root = join(directory, "Vault with spaces");
  const profile = join(directory, "profile");
  for (const path of [
    join(root, ".obsidian"),
    join(root, "Inbox"),
    profile,
    join(directory, "resources"),
  ])
    mkdirSync(path, { recursive: true });
  const executable = join(directory, "fixture.exe");
  writeFileSync(executable, "fixture executable, never spawned");
  writeFileSync(join(directory, "resources", "app.asar"), "loader");
  writeFileSync(join(directory, "resources", "obsidian.asar"), "app");
  writeFileSync(
    join(profile, "obsidian.json"),
    JSON.stringify({
      cli: true,
      vaults: { fixtureVaultId: { path: root, open: true } },
    }),
  );
  const scope: FileScopeRecord = {
    id: "fixture-scope",
    alias: "garden",
    aliases: ["garden"],
    path: root,
    read: true,
    write: true,
    defaultSave: false,
    kind: "obsidian",
    createdAt: 1,
    updatedAt: 1,
  };
  const content = new Map<string, string>();
  const qualification: ObsidianQualification = {
    adapterVersion: 1,
    executableIdentity: executableIdentity(executable),
    applicationIdentity: applicationIdentity(executable),
    appVersion: "fixture",
    qualifiedAt: 1,
    enabled: true,
    evidence: "unit fixture",
    passthrough: true,
    operations: Object.fromEntries(
      obsidianOperations.map((operation) => [
        operation,
        {
          supported: !["edit", "delete"].includes(operation),
          reason:
            operation === "edit"
              ? "No expected-revision CAS equivalent."
              : operation === "delete"
                ? "System Recycle Bin equivalence is unqualified."
                : "Fixture-qualified",
        },
      ]),
    ) as ObsidianQualification["operations"],
  };
  const runner = vi.fn<NonNullable<ObsidianAdapterOptions["runner"]>>(
    async (input) => {
      const command = input.args[2];
      const path = input.args.find((arg) => arg.startsWith("path="))?.slice(5);
      let stdout = "help read create move rename";
      if (command === "read" && path)
        stdout = `\r\n${readFileSync(join(root, path), "utf8")}`;
      if (command === "create" && path) {
        const body = input.args
          .find((arg) => arg.startsWith("content="))!
          .slice(8)
          .replace(/\\n/gu, "\n")
          .replace(/\\t/gu, "\t");
        writeFileSync(join(root, path), body, { flag: "wx" });
        stdout = `Created: ${path}`;
      }
      return {
        code: 0,
        stdout,
        stderr: "",
        timedOut: false,
        cancelled: false,
        spawned: true,
      };
    },
  );
  const options: ObsidianAdapterOptions = {
    scopes: () => [scope],
    generation: () => 1,
    executable,
    application: executable,
    profileDirectory: profile,
    qualification: () => qualification,
    content: {
      put: (_thread, text) => {
        content.set("body-ref", text);
        return "body-ref";
      },
      get: (_thread, id) => content.get(id) ?? null,
    },
    runner,
  };
  return { options, root, runner, qualification, scope, directory };
}
const context = { actor: "model" as const, threadId: "thread", turnId: "turn" };
describe("Obsidian adapter contracts", () => {
  it("exposes explicit wrapper aliases with exact reads, approved writes and unsupported edits without effects", async () => {
    const { options, root, runner } = fixture();
    writeFileSync(join(root, "Inbox", "Exact.md"), "Original body");
    const database = new DatabaseSync(":memory:");
    migrateDatabase(database, VERBO_MIGRATIONS);
    const registry = createModuleRegistry(
      [obsidianModule],
      obsidianBindings(undefined, () => options),
      { preparation: createPreparationOwner(database) },
    );
    expect(
      await registry.invoke(
        "vault.cat",
        { vault: "garden", path: "Inbox/Exact.md" },
        context,
      ),
    ).toMatchObject({ action: "obsidian.read", status: "success" });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(
      await registry.invoke(
        "obsidian.write",
        { vault: "garden", path: "Inbox/New.md", content: "New body" },
        context,
      ),
    ).toMatchObject({
      action: "obsidian.create",
      status: "requires_confirmation",
    });
    expect(existsSync(join(root, "Inbox", "New.md"))).toBe(false);
    expect(
      await registry.invoke(
        "obsidian.update",
        {
          vault: "garden",
          path: "Inbox/Exact.md",
          content: "Replacement",
          revision: "0".repeat(64),
        },
        context,
      ),
    ).toMatchObject({ action: "obsidian.edit", status: "not_supported" });
    expect(readFileSync(join(root, "Inbox", "Exact.md"), "utf8")).toBe(
      "Original body",
    );
    expect(runner).toHaveBeenCalledTimes(1);
    database.close();
  });
  it("records verified backlink changes alongside a moved note without claiming complete effects", async () => {
    const { options, root } = fixture();
    writeFileSync(join(root, "Inbox", "Same.md"), "Original body");
    writeFileSync(join(root, "Links.md"), "[[Inbox/Same]]");
    const adapter = createObsidianAdapter({
      ...options,
      runner: async () => {
        renameSync(
          join(root, "Inbox", "Same.md"),
          join(root, "Inbox", "Moved.md"),
        );
        writeFileSync(join(root, "Links.md"), "[[Inbox/Moved]]");
        return {
          code: 0,
          stdout: "Moved",
          stderr: "",
          spawned: true,
          timedOut: false,
          cancelled: false,
        };
      },
    });
    const observed = await collectCommandResources(() =>
      adapter.execute(
        "move",
        { vault: "garden", path: "Inbox/Same.md", to: "Inbox/Moved.md" },
        context,
      ),
    );
    expect(observed.result).toMatchObject({
      status: "success",
      data: { relatedResources: { changed: 2, removed: 1, truncated: false } },
    });
    expect(
      observed.resources.map((resource) => resource.path.replace(/\\/gu, "/")),
    ).toEqual(
      expect.arrayContaining([
        join(root, "Links.md").replace(/\\/gu, "/"),
        join(root, "Inbox", "Moved.md").replace(/\\/gu, "/"),
      ]),
    );
  });
  it("targets exact paths and retains bounded body identity/revision outside command data", async () => {
    const { options, root, runner } = fixture();
    writeFileSync(join(root, "Inbox", "Same.md"), "# Café\nBody");
    const result = await createObsidianAdapter(options).execute(
      "read",
      { vault: "garden", path: "Inbox/Same.md" },
      context,
    );
    expect(result).toMatchObject({
      status: "success",
      data: { path: "Inbox/Same.md", contentRef: "body-ref" },
    });
    expect(result.data).not.toHaveProperty("body");
    expect(runner.mock.calls[0]![0].args).toEqual([
      `--user-data-dir=${options.profileDirectory}`,
      "vault=fixtureVaultId",
      "read",
      "path=Inbox/Same.md",
    ]);
    expect(JSON.stringify(result.data)).toContain('"revision"');
  });
  it("blocks unsupported full edit/trash, invalid literal escapes and executable drift before dispatch", async () => {
    const { options, runner, qualification, directory } = fixture();
    const adapter = createObsidianAdapter(options);
    expect(
      await adapter.execute(
        "edit",
        {
          vault: "garden",
          path: "Inbox/Same.md",
          content: "New",
          revision: "0".repeat(64),
        },
        context,
      ),
    ).toMatchObject({
      status: "not_supported",
      summary: expect.stringContaining("CAS"),
    });
    expect(
      await adapter.execute(
        "delete",
        { vault: "garden", path: "Inbox/Same.md" },
        context,
      ),
    ).toMatchObject({
      status: "not_supported",
      summary: expect.stringContaining("Recycle Bin"),
    });
    expect(
      await adapter.execute(
        "create",
        { vault: "garden", path: "Inbox/New.md", content: "literal \\n" },
        context,
      ),
    ).toMatchObject({ status: "not_supported" });
    writeFileSync(
      join(directory, "resources", "obsidian.asar"),
      "changed runtime version",
    );
    expect(
      await adapter.execute(
        "create",
        { vault: "garden", path: "Inbox/New.md", content: "Safe body" },
        context,
      ),
    ).toMatchObject({ status: "not_supported" });
    expect(runner).not.toHaveBeenCalled();
    qualification.enabled = false;
  });
  it("verifies created content and marks interrupted effects uncertain", async () => {
    const { options, root } = fixture();
    const adapter = createObsidianAdapter(options);
    expect(
      await adapter.execute(
        "create",
        { vault: "garden", path: "Inbox/New.md", content: "New\nBody" },
        context,
      ),
    ).toMatchObject({ status: "success" });
    expect(readFileSync(join(root, "Inbox", "New.md"), "utf8")).toBe(
      "New\nBody",
    );
    const uncertain = createObsidianAdapter({
      ...options,
      runner: async () => ({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: true,
        cancelled: false,
        spawned: true,
      }),
    });
    expect(
      await uncertain.execute(
        "create",
        { vault: "garden", path: "Inbox/Other.md", content: "Body" },
        context,
      ),
    ).toMatchObject({ code: "effect_uncertain" });
  });
  it("requires module-wide authority for passthrough, rejects eval and keeps known reads prompt-free", async () => {
    const { options, runner } = fixture();
    const database = new DatabaseSync(":memory:");
    migrateDatabase(database, VERBO_MIGRATIONS);
    const bindings = obsidianBindings(undefined, () => options);
    const registry = createModuleRegistry([obsidianModule], bindings, {
      preparation: createPreparationOwner(database),
    });
    const actionOnly = createInvocationPolicy({
      id: "specific",
      agentId: "commander",
      exposed: true,
      allowed: { modules: [], actions: ["obsidian.cli"] },
      discoverable: { modules: [], actions: ["obsidian.cli"] },
      forbidden: [],
    });
    expect(
      await registry.invoke(
        "obsidian.cli",
        { vault: "garden", command: "help", args: [] },
        { ...context, invocation: actionOnly },
      ),
    ).toMatchObject({ code: "module_authority_required" });
    const moduleWide = createInvocationPolicy({
      ...actionOnly,
      id: "module",
      allowed: { modules: ["obsidian"], actions: [] },
      discoverable: { modules: ["obsidian"], actions: [] },
    });
    expect(
      await registry.invoke(
        "obsidian.cli",
        { vault: "garden", command: "eval", args: ["code=1+1"] },
        { ...context, invocation: moduleWide },
      ),
    ).toMatchObject({ code: "host_ineligible" });
    expect(
      await withInvocation(moduleWide, () =>
        registry.invoke(
          "obsidian.cli",
          { vault: "garden", command: "help", args: [] },
          context,
        ),
      ),
    ).toMatchObject({ status: "success" });
    const prior = runner.mock.calls.length;
    const prepared = await registry.invoke(
      "obsidian.cli",
      {
        vault: "garden",
        command: "plugin:unknown-effect",
        args: ["value=some text"],
      },
      { ...context, invocation: moduleWide },
    );
    expect(prepared).toMatchObject({ status: "requires_confirmation" });
    expect(runner).toHaveBeenCalledTimes(prior);
    const stored = database
      .prepare("SELECT risk_json FROM operation_plans WHERE id=?")
      .get(prepared.operationId!);
    expect(String(stored?.risk_json)).toContain("outside the selected vault");
    expect(existsSync(join(options.profileDirectory, "obsidian.json"))).toBe(
      true,
    );
    database.close();
  });
});
