import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const state = vi.hoisted(() => ({ root: "", packaged: false, appData: "" }));
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return state.packaged;
    },
    getAppPath: () => state.root,
    getPath: () => state.appData,
  },
}));
import { aloRuntime } from "./runtime";
let directory: string;
const resourcesDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "resourcesPath",
);
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "verbo-runtime-"));
  state.root = join(directory, "app");
  state.appData = join(directory, "profiles");
  state.packaged = false;
  vi.stubEnv("VERBO_ALO_NODE", "");
  vi.stubEnv("VERBO_ALO_ENTRY", "");
  vi.stubEnv("VERBO_ALO_PROFILE", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (resourcesDescriptor)
    Object.defineProperty(process, "resourcesPath", resourcesDescriptor);
  else delete (process as unknown as Record<string, unknown>).resourcesPath;
  rmSync(directory, { recursive: true, force: true });
});
function fixture(root: string): void {
  const entry = join(root, "app/node_modules/alo/dist/cli");
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(root, "node.exe"), "fixture");
  writeFileSync(join(entry, "main.js"), "fixture");
}
it("resolves its prepared development bundle independently of the shell working directory", () => {
  const root = join(state.root, "resources/alo");
  fixture(root);
  expect(aloRuntime()).toEqual({
    node: join(root, "node.exe"),
    entry: join(root, "app/node_modules/alo/dist/cli/main.js"),
    profile: join(state.appData, "alo/alo.sqlite"),
  });
});
it("resolves the packaged pair outside asar without an adjacent checkout", () => {
  const resources = join(directory, "resources");
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: resources,
  });
  state.packaged = true;
  fixture(join(resources, "alo"));
  expect(aloRuntime().node).toBe(join(resources, "alo/node.exe"));
  expect(aloRuntime().entry.startsWith(state.root)).toBe(false);
});
it("fails closed for an incomplete override or missing bundle", () => {
  vi.stubEnv("VERBO_ALO_NODE", process.execPath);
  expect(() => aloRuntime()).toThrow(/three absolute/);
  vi.stubEnv("VERBO_ALO_NODE", "");
  expect(() => aloRuntime()).toThrow(/bundled Alo runtime is missing/);
});
