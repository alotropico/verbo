import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_WEB_SETTINGS, type WebSettings } from "../../shared/web-settings";
import { loadWebSettings, saveWebSettings } from "./settings-store";

describe("settings-store", () => {
  it("returns default settings when file does not exist", () => {
    const filePath = join(tmpdir(), "nonexistent-web-settings-xyz.json");
    expect(loadWebSettings(filePath)).toEqual(DEFAULT_WEB_SETTINGS);
  });

  it("returns default settings on corrupt JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "verbo-web-settings-test-"));
    try {
      const filePath = join(dir, "web-settings.json");
      writeFileSync(filePath, "{ corrupt json ...", "utf8");
      expect(loadWebSettings(filePath)).toEqual(DEFAULT_WEB_SETTINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains valid fields on partial JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "verbo-web-settings-test-"));
    try {
      const filePath = join(dir, "web-settings.json");
      writeFileSync(filePath, JSON.stringify({ pageSize: 8, engines: ["github", "wikipedia"] }), "utf8");
      const loaded = loadWebSettings(filePath);
      expect(loaded.pageSize).toBe(8);
      expect(loaded.engines).toEqual(["github", "wikipedia"]);
      expect(loaded.maxSnippetChars).toBe(DEFAULT_WEB_SETTINGS.maxSnippetChars);
      expect(loaded.timeoutMs).toBe(DEFAULT_WEB_SETTINGS.timeoutMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips valid settings preserving engine order", () => {
    const dir = mkdtempSync(join(tmpdir(), "verbo-web-settings-test-"));
    try {
      const filePath = join(dir, "web-settings.json");
      const custom: WebSettings = {
        engines: ["bing", "duckduckgo", "github"],
        pageSize: 7,
        maxSnippetChars: 350,
        timeoutMs: 12000,
      };
      saveWebSettings(custom, filePath);
      const loaded = loadWebSettings(filePath);
      expect(loaded).toEqual(custom);
      expect(loaded.engines).toEqual(["bing", "duckduckgo", "github"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid save without corrupting or modifying existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "verbo-web-settings-test-"));
    try {
      const filePath = join(dir, "web-settings.json");
      const valid: WebSettings = {
        engines: ["duckduckgo"],
        pageSize: 3,
        maxSnippetChars: 200,
        timeoutMs: 5000,
      };
      saveWebSettings(valid, filePath);

      const invalid = {
        ...valid,
        pageSize: 99, // out of range
      } as unknown as WebSettings;

      expect(() => saveWebSettings(invalid, filePath)).toThrow();
      const content = JSON.parse(readFileSync(filePath, "utf8"));
      expect(content.pageSize).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
