/** Every backend test gets isolated command storage; tests never select the real user profile. */
import { afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "verbo-alo-test-"));
  vi.stubEnv("VERBO_ALO_NODE", process.execPath);
  vi.stubEnv("VERBO_ALO_ENTRY", resolve("../alo/dist/cli/main.js"));
  vi.stubEnv("VERBO_ALO_PROFILE", join(directory, "alo.sqlite"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
