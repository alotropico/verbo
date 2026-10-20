/** Fixture-only owner access. Production Verbo never opens the Alo database. */
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, vi } from "vitest";
import type { ActionContext } from "../capabilities/registry";
import type { ActionResult } from "../../shared/action-contract";
import type { CommandResource } from "../../shared/command-receipts";
const require = createRequire(import.meta.url);
type Input = {
  result: ActionResult;
  context: ActionContext;
  startedAt: number;
  resources: CommandResource[];
};
const owner = require(
  resolve("../alo/dist/profile/stores/command-receipts.js"),
) as {
  persistCommandReceipt(database: DatabaseSync, input: Input): ActionResult;
};
const profile = require(resolve("../alo/dist/profile/database.js")) as {
  openProfile(path: string): DatabaseSync;
};
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "verbo-owner-fixture-"));
  vi.stubEnv("VERBO_ALO_NODE", process.execPath);
  vi.stubEnv("VERBO_ALO_ENTRY", resolve("../alo/dist/cli/main.js"));
  vi.stubEnv("VERBO_ALO_PROFILE", join(directory, "alo.sqlite"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
export function persistCommandReceipt(
  _database: DatabaseSync,
  input: Input,
): ActionResult {
  const database = profile.openProfile(process.env.VERBO_ALO_PROFILE!);
  try {
    return owner.persistCommandReceipt(database, input);
  } finally {
    database.close();
  }
}
export function fixtureReceiptIds(): { id: string }[] {
  const database = profile.openProfile(process.env.VERBO_ALO_PROFILE!);
  try {
    return database
      .prepare("SELECT id FROM command_receipts ORDER BY id")
      .all()
      .map((row) => ({ id: String(row.id) }));
  } finally {
    database.close();
  }
}
