import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  naivePrefixContains,
  resolveContainedPath,
} from "./windows-containment";

const roots: string[] = [];

function makeRoot(): { root: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "verbo-root-"));
  const outside = mkdtempSync(join(tmpdir(), "verbo-out-"));
  roots.push(root, outside);
  return { root, outside };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("windows handle containment", () => {
  it("rejects a junction that a string prefix still treats as inside", () => {
    const { root, outside } = makeRoot();
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret");
    const link = join(root, "jump");
    symlinkSync(outside, link, "junction");
    const candidate = join(link, "secret.txt");

    expect(naivePrefixContains(root, candidate)).toBe(true);
    expect(resolveContainedPath(root, candidate)).toEqual({
      ok: false,
      code: "outside",
    });
  });

  it("accepts a real child and a missing leaf whose parent stays inside", () => {
    const { root } = makeRoot();
    const file = join(root, "note.md");
    writeFileSync(file, "note");
    const existing = resolveContainedPath(root, file);
    expect(existing.ok).toBe(true);
    if (existing.ok) expect(existing.exists).toBe(true);

    const missing = resolveContainedPath(root, join(root, "later.md"));
    expect(missing).toMatchObject({
      ok: true,
      exists: false,
      leaf: "later.md",
    });
  });

  it("rejects lexical escapes, device paths, and writes to the root itself", () => {
    const { root } = makeRoot();
    mkdirSync(join(root, "nested"));
    expect(
      resolveContainedPath(root, join(root, "nested", "..", "..", "Windows"))
        .ok,
    ).toBe(false);
    expect(resolveContainedPath(root, "\\\\server\\share\\note.md")).toEqual({
      ok: false,
      code: "unc",
    });
    expect(resolveContainedPath(root, "\\\\.\\C:\\Windows")).toEqual({
      ok: false,
      code: "device",
    });
    expect(resolveContainedPath(root, root, "write")).toEqual({
      ok: false,
      code: "root",
    });
  });

  it("rejects a missing file reached through a junction", () => {
    const { root, outside } = makeRoot();
    const link = join(root, "jump");
    symlinkSync(outside, link, "junction");
    expect(resolveContainedPath(root, join(link, "new.txt"))).toEqual({
      ok: false,
      code: "outside",
    });
  });
});
