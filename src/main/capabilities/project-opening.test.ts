import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { registryForDatabase } from "./catalog";
import { createRootStore } from "../db/registered-roots";
import {
  readEntitySettings,
  saveApplicationRegistration,
  saveProjectPreferences,
} from "../db/application-registration";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";
import {
  decideOperation,
  reviewOperation,
  reconcileOperations,
} from "../files/mutation-plan";
import { operationSession } from "../files/mutation-ports";
import { createScopeStore } from "../db/scopes";
import { createOperationStore } from "../db/operations";
import { readCommandReceipt } from "../db/command-receipts";
import type { RegisteredProject } from "../../shared/application-registration";

const context = {
  actor: "model" as const,
  threadId: "opening-thread",
  turnId: "opening-turn",
};
function fixture(): {
  db: DatabaseSync;
  directory: string;
  marker: string;
  project: RegisteredProject;
  dispose: () => Promise<void>;
} {
  const directory = mkdtempSync(join(tmpdir(), "verbo-app-open-"));
  const db = new DatabaseSync(":memory:");
  migrateDatabase(db, VERBO_MIGRATIONS);
  const projectPath = join(directory, "área & $(literal)");
  mkdirSync(projectPath);
  const added = createRootStore(db, "registered_projects", "project").add(
    "watcher",
    projectPath,
  );
  if (!added.ok) throw new Error(added.summary);
  const marker = join(directory, "launches.txt");
  for (const name of ["cursor", "vsc", "smerge"]) {
    const script = `require('node:fs').appendFileSync(process.argv[1],${JSON.stringify(name)}+':'+process.argv[2]+'\\n')`;
    expect(
      saveApplicationRegistration(db, {
        name,
        aliases: [name, `${name}-alias`],
        executable: process.execPath,
        enabled: true,
        supportedTargets: ["folder", "repository"],
        supportedPlatforms: ["win32"],
        cwdPolicy: "project",
        launchArguments: [
          { literal: "-e" },
          { literal: script },
          { literal: "--" },
          { literal: marker },
          { target: "path" },
        ],
      }).ok,
    ).toBe(true);
  }
  const settings = readEntitySettings(db);
  const project = settings.projects[0]!;
  expect(
    saveProjectPreferences(db, {
      id: project.id,
      name: "Watcher",
      aliases: ["watch", "wt"],
      enabled: true,
      defaultApplicationId: settings.applications[0]!.id,
      favoriteApplicationIds: settings.applications.map((app) => app.id),
    }).ok,
  ).toBe(true);
  return {
    db,
    directory,
    marker,
    project: readEntitySettings(db).projects[0]!,
    dispose: async () => {
      // Spawn evidence precedes OS exit. Wait for our fixture programs to release
      // their cwd rather than racing directory cleanup after marker writes.
      const pids = db
        .prepare(
          "SELECT result_json FROM command_receipts WHERE action_id='software.launch'",
        )
        .all()
        .map((row) => JSON.parse(String(row.result_json)).data?.pid)
        .filter((pid): pid is number => typeof pid === "number");
      const deadline = Date.now() + 3000;
      while (
        Date.now() < deadline &&
        pids.some((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      db.close();
      const resolved = realpathSync(directory);
      const child = relative(realpathSync(tmpdir()), resolved);
      if (
        isAbsolute(child) ||
        child.startsWith("..") ||
        !child.startsWith("verbo-app-open-")
      )
        throw new Error("Unsafe fixture cleanup.");
      // A spawned Windows process may briefly retain its cwd after reporting argv.
      rmSync(resolved, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 25,
      });
    },
  };
}
async function waitForLines(file: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const lines = existsSync(file)
      ? readFileSync(file, "utf8").trim().split("\n")
      : [];
    if (lines.length >= count) return lines;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Fixture subprocess did not report its arguments.");
}

describe.skipIf(process.platform !== "win32")(
  "registered project opening",
  () => {
    it("uses the configured default via registered children and verifies actual OS spawn without granting writes", async () => {
      const f = fixture();
      try {
        const registry = registryForDatabase(f.db);
        const pending = await registry.invoke(
          "project.edit",
          { project: "watch" },
          context,
        );
        expect(pending.status).toBe("requires_confirmation");
        expect(existsSync(f.marker)).toBe(false);
        expect(createScopeStore(f.db).list()).toEqual([]);
        const completed = await decideOperation({
          database: f.db,
          scopes: createScopeStore(f.db),
          operationId: pending.operationId!,
          threadId: context.threadId,
          sessionId: operationSession(),
          decision: "approve",
        });
        expect(completed.status).toBe("success");
        expect(await waitForLines(f.marker, 1)).toEqual([
          `cursor:${f.project.path}`,
        ]);
        const receipt = readCommandReceipt(
          f.db,
          completed.receiptId!,
          context.threadId,
        )!;
        expect(receipt.resources).toEqual([]);
        expect(receipt.children).toHaveLength(3);
        expect(receipt.children).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              action: "software.launch",
              receiptId: expect.any(String),
            }),
          ]),
        );
        expect(
          (
            await decideOperation({
              database: f.db,
              scopes: createScopeStore(f.db),
              operationId: pending.operationId!,
              threadId: context.threadId,
              sessionId: operationSession(),
              decision: "approve",
            })
          ).code,
        ).toBe("replayed");
        expect(createScopeStore(f.db).list()).toEqual([]);
      } finally {
        await f.dispose();
      }
    });
    it("deduplicates aliases in input order and displays every exact launch in one review", async () => {
      const f = fixture();
      try {
        const pending = await registryForDatabase(f.db).invoke(
          "projects.open",
          {
            project: "wt",
            applications: ["smerge", "cursor-alias", "cursor", "vsc"],
          },
          context,
        );
        expect(pending.status).toBe("requires_confirmation");
        expect(pending.totalItems).toBe(3);
        const review = reviewOperation({
          database: f.db,
          scopes: createScopeStore(f.db),
          operationId: pending.operationId!,
          threadId: context.threadId,
          sessionId: operationSession(),
        });
        expect(review.ok).toBe(true);
        if (!review.ok) throw new Error(review.summary);
        expect(review.items.map((item) => item.to)).toEqual([
          "Open Watcher in smerge.",
          "Open Watcher in cursor.",
          "Open Watcher in vsc.",
        ]);
        expect(JSON.parse(review.items[0]!.diff!)).toMatchObject({
          executable: realpathSync(process.execPath),
          target: f.project.path,
          arguments: expect.arrayContaining([f.project.path]),
        });
        const result = await decideOperation({
          database: f.db,
          scopes: createScopeStore(f.db),
          operationId: pending.operationId!,
          threadId: context.threadId,
          sessionId: operationSession(),
          decision: "approve",
        });
        expect(result.status).toBe("success");
        // OS processes may finish in a different order; invocation order is the durable receipt order.
        expect((await waitForLines(f.marker, 3)).sort()).toEqual(
          [
            `cursor:${f.project.path}`,
            `smerge:${f.project.path}`,
            `vsc:${f.project.path}`,
          ].sort(),
        );
        const launches = f.db
          .prepare(
            "SELECT result_json FROM command_receipts WHERE action_id='software.launch' ORDER BY rowid",
          )
          .all();
        expect(
          launches.map(
            (row) => JSON.parse(String(row.result_json)).data.applicationId,
          ),
        ).toEqual([
          readEntitySettings(f.db).applications[2]!.id,
          readEntitySettings(f.db).applications[0]!.id,
          readEntitySettings(f.db).applications[1]!.id,
        ]);
      } finally {
        await f.dispose();
      }
    });
    it("invalidates a pending pairing after project defaults or application arguments change", async () => {
      for (const change of ["default", "arguments"] as const) {
        const f = fixture();
        try {
          const pending = await registryForDatabase(f.db).invoke(
            "projects.open",
            { project: "watcher" },
            context,
          );
          const settings = readEntitySettings(f.db);
          if (change === "default")
            expect(
              saveProjectPreferences(f.db, {
                id: f.project.id,
                name: f.project.name,
                aliases: ["watch", "wt"],
                enabled: true,
                defaultApplicationId: settings.applications[1]!.id,
                favoriteApplicationIds: settings.applications.map(
                  (app) => app.id,
                ),
              }).ok,
            ).toBe(true);
          else {
            const app = settings.applications[0]!;
            expect(
              saveApplicationRegistration(f.db, {
                id: app.id,
                name: app.name,
                aliases: app.aliases,
                executable: app.executable,
                enabled: app.enabled,
                supportedPlatforms: app.supportedPlatforms,
                supportedTargets: app.supportedTargets,
                cwdPolicy: app.cwdPolicy,
                launchArguments: [
                  ...app.launchArguments,
                  { literal: "changed" },
                ],
              }).ok,
            ).toBe(true);
          }
          expect(
            (
              await decideOperation({
                database: f.db,
                scopes: createScopeStore(f.db),
                operationId: pending.operationId!,
                threadId: context.threadId,
                sessionId: operationSession(),
                decision: "approve",
              })
            ).code,
          ).toBe("stale_target");
          expect(existsSync(f.marker)).toBe(false);
        } finally {
          await f.dispose();
        }
      }
    });
    it("fails unknown registrations usefully and never treats a model executable or confirmation field as authority", async () => {
      const f = fixture();
      try {
        const registry = registryForDatabase(f.db);
        expect(
          (
            await registry.invoke(
              "software.launch",
              { application: process.execPath, project: "watch" },
              context,
            )
          ).code,
        ).toBe("not_registered");
        expect(
          (
            await registry.invoke(
              "software.launch",
              {
                application: "cursor",
                project: "watch",
                skipConfirmation: true,
              },
              context,
            )
          ).code,
        ).toBe("invalid_args");
        const unknown = await registry.invoke(
          "projects.open",
          { project: "watch", applications: ["missing"] },
          context,
        );
        expect(unknown.status).toBe("error");
        expect(unknown.summary).toContain("not registered");
        expect(existsSync(f.marker)).toBe(false);
        expect(
          createRootStore(f.db, "registered_projects", "project").add(
            "watch",
            f.directory,
          ).ok,
        ).toBe(false);
      } finally {
        await f.dispose();
      }
    });
    it("keeps interrupted external effects for review and never replays them", async () => {
      const f = fixture();
      try {
        const pending = await registryForDatabase(f.db).invoke(
          "projects.open",
          { project: "watch" },
          context,
        );
        const store = createOperationStore(f.db);
        store.claim(pending.operationId!, Date.now());
        store.markItem(store.items(pending.operationId!)[0]!.id, {
          status: "uncertain",
        });
        expect(reconcileOperations(f.db)).toBe(1);
        expect(
          (
            await decideOperation({
              database: f.db,
              scopes: createScopeStore(f.db),
              operationId: pending.operationId!,
              threadId: context.threadId,
              sessionId: operationSession(),
              decision: "approve",
            })
          ).code,
        ).toBe("needs_review");
        expect(existsSync(f.marker)).toBe(false);
      } finally {
        await f.dispose();
      }
    });
    it("rejects renamed scripts and corrupt preferences fail closed", async () => {
      const f = fixture();
      try {
        const executable = join(f.directory, "renamed.exe");
        writeFileSync(executable, "not a PE executable".repeat(10));
        expect(
          saveApplicationRegistration(f.db, {
            name: "Bad",
            aliases: ["bad"],
            executable,
            enabled: true,
            supportedTargets: ["folder"],
            supportedPlatforms: ["win32"],
            cwdPolicy: "project",
            launchArguments: [{ target: "path" }],
          }).ok,
        ).toBe(false);
        f.db
          .prepare(
            "UPDATE project_preferences SET value_json='broken' WHERE project_id=?",
          )
          .run(f.project.id);
        expect(readEntitySettings(f.db).projects[0]!.enabled).toBe(false);
      } finally {
        await f.dispose();
      }
    });
  },
);
