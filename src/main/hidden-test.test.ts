import { expect, it } from "vitest";
import { join, resolve } from "node:path";
import { hiddenTestPaths } from "./hidden-test";

it("leaves ordinary startup unchanged and rejects incomplete or packaged isolation", () => {
  expect(hiddenTestPaths({}, false)).toBeNull();
  expect(() => hiddenTestPaths({ VERBO_HIDDEN_TEST_ROOT: "relative" }, false)).toThrow();
  const root = resolve("campaign");
  const env = {
    VERBO_HIDDEN_TEST_ROOT: root,
    VERBO_ALO_NODE: resolve("node.exe"),
    VERBO_ALO_ENTRY: resolve("alo/main.js"),
    VERBO_ALO_PROFILE: join(root, "alo-profile", "alo.sqlite"),
  };
  expect(() => hiddenTestPaths(env, true)).toThrow();
  expect(() => hiddenTestPaths({ ...env, VERBO_ALO_ENTRY: undefined }, false)).toThrow();
  expect(hiddenTestPaths(env, false)?.userData).toBe(join(root, "user-data"));
});
