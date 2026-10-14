import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { discoverApplicationCandidates } from "./application-candidates";

describe("available application discovery", () => {
  it("offers verified installed binaries once, skips helpers and does not execute programs", () => {
    const root = mkdtempSync(join(tmpdir(), "verbo-discovery-"));
    try {
      const pe = Buffer.alloc(128);
      pe.writeUInt16LE(0x5a4d, 0);
      pe.writeUInt32LE(64, 0x3c);
      pe.writeUInt32LE(0x4550, 64);
      writeFileSync(join(root, "fixture-editor.exe"), pe);
      writeFileSync(join(root, "uninstall.exe"), pe);
      writeFileSync(join(root, "fake.exe"), "not a PE executable");
      let reads = 0;
      const result = discoverApplicationCandidates({
        platform: "win32",
        locate: () => [],
        installed: () => {
          reads++;
          return {
            programs: [
              { name: "Fixture", location: root, version: "", publisher: "" },
              { name: "Duplicate", location: root, version: "", publisher: "" },
            ],
            complete: true,
          };
        },
      });
      expect(reads).toBe(1);
      const fixture = result.filter((candidate) =>
        candidate.executable.toLowerCase().includes(root.toLowerCase()),
      );
      expect(fixture).toHaveLength(1);
      expect(fixture[0].aliases).toEqual(["fixture-editor"]);
      expect(
        discoverApplicationCandidates({
          platform: "linux",
          installed: () => {
            throw new Error("No inventory on this platform");
          },
          locate: () => [],
        }),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
