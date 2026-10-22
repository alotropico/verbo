import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEB_SETTINGS,
  getDefaultWebSettings,
  recoverWebSettings,
  sameWebSettings,
  webSettingsSchema,
  type WebSettings,
} from "./web-settings";

describe("web-settings", () => {
  it("provides valid default settings", () => {
    expect(webSettingsSchema.safeParse(DEFAULT_WEB_SETTINGS).success).toBe(true);
    expect(DEFAULT_WEB_SETTINGS.engines).toEqual(["duckduckgo", "brave", "bing"]);
    expect(DEFAULT_WEB_SETTINGS.pageSize).toBe(5);
    expect(DEFAULT_WEB_SETTINGS.maxSnippetChars).toBe(240);
    expect(DEFAULT_WEB_SETTINGS.timeoutMs).toBe(8000);
  });

  describe("webSettingsSchema validation", () => {
    it("accepts valid custom settings", () => {
      const valid: WebSettings = {
        engines: ["bing", "google", "wikipedia"],
        pageSize: 10,
        maxSnippetChars: 500,
        timeoutMs: 20000,
      };
      expect(webSettingsSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects pageSize boundaries, fractions, and non-numbers", () => {
      expect(webSettingsSchema.safeParse({ ...DEFAULT_WEB_SETTINGS, pageSize: 0 }).success).toBe(false);
      expect(webSettingsSchema.safeParse({ ...DEFAULT_WEB_SETTINGS, pageSize: 11 }).success).toBe(false);
      expect(webSettingsSchema.safeParse({ ...DEFAULT_WEB_SETTINGS, pageSize: 5.5 }).success).toBe(false);
      expect(webSettingsSchema.safeParse({ ...DEFAULT_WEB_SETTINGS, pageSize: "5" }).success).toBe(false);
    });

    it("rejects maxSnippetChars boundaries and fractions", () => {
      expect(webSettingsSchema.safeParse({ ...DEFAULT_WEB_SETTINGS, maxSnippetChars: 99 }).success).toBe(false);
      expect(webSettingsSchema.safeParse({ ...DEFAULT_WEB_SETTINGS, maxSnippetChars: 501 }).success).toBe(false);
      expect(webSettingsSchema.safeParse({ ...DEFAULT_WEB_SETTINGS, maxSnippetChars: 240.2 }).success).toBe(false);
    });

    it("rejects timeoutMs boundaries and fractions", () => {
      expect(webSettingsSchema.safeParse({ ...DEFAULT_WEB_SETTINGS, timeoutMs: 1999 }).success).toBe(false);
      expect(webSettingsSchema.safeParse({ ...DEFAULT_WEB_SETTINGS, timeoutMs: 20001 }).success).toBe(false);
      expect(webSettingsSchema.safeParse({ ...DEFAULT_WEB_SETTINGS, timeoutMs: 8000.5 }).success).toBe(false);
    });

    it("rejects duplicate, empty, or unknown engines", () => {
      expect(webSettingsSchema.safeParse({ ...DEFAULT_WEB_SETTINGS, engines: [] }).success).toBe(false);
      expect(
        webSettingsSchema.safeParse({
          ...DEFAULT_WEB_SETTINGS,
          engines: ["duckduckgo", "duckduckgo"],
        }).success,
      ).toBe(false);
      expect(
        webSettingsSchema.safeParse({
          ...DEFAULT_WEB_SETTINGS,
          engines: ["unknown"],
        }).success,
      ).toBe(false);
    });

    it("rejects unknown extra keys", () => {
      expect(webSettingsSchema.safeParse({ ...DEFAULT_WEB_SETTINGS, extraKey: "disallowed" }).success).toBe(false);
    });
  });

  describe("recoverWebSettings", () => {
    it("returns clone of valid settings", () => {
      const recovered = recoverWebSettings(DEFAULT_WEB_SETTINGS);
      expect(recovered).toEqual(DEFAULT_WEB_SETTINGS);
      expect(recovered.engines).not.toBe(DEFAULT_WEB_SETTINGS.engines);
    });

    it("falls back to default on null or non-record", () => {
      expect(recoverWebSettings(null)).toEqual(DEFAULT_WEB_SETTINGS);
      expect(recoverWebSettings(undefined)).toEqual(DEFAULT_WEB_SETTINGS);
      expect(recoverWebSettings("string")).toEqual(DEFAULT_WEB_SETTINGS);
      expect(recoverWebSettings([1, 2, 3])).toEqual(DEFAULT_WEB_SETTINGS);
    });

    it("retains valid fields and defaults invalid/corrupt fields", () => {
      const corrupt = {
        pageSize: 8,
        maxSnippetChars: 999999, // invalid -> default to 240
        timeoutMs: -500, // invalid -> default to 8000
        engines: ["wikipedia", "invalid", "wikipedia"], // keeps first unique valid: ["wikipedia"]
      };
      const recovered = recoverWebSettings(corrupt);
      expect(recovered.pageSize).toBe(8);
      expect(recovered.maxSnippetChars).toBe(240);
      expect(recovered.timeoutMs).toBe(8000);
      expect(recovered.engines).toEqual(["wikipedia"]);
    });

    it("falls back to default engines if engines array is empty or has no valid items", () => {
      const recovered = recoverWebSettings({ engines: [] });
      expect(recovered.engines).toEqual(DEFAULT_WEB_SETTINGS.engines);
    });

    it("provides an independent copy of default array", () => {
      const a = getDefaultWebSettings();
      const b = getDefaultWebSettings();
      a.engines.push("github");
      expect(b.engines).toEqual(DEFAULT_WEB_SETTINGS.engines);
      expect(DEFAULT_WEB_SETTINGS.engines).not.toContain("github");
    });
  });

  describe("sameWebSettings", () => {
    it("returns true for identical settings", () => {
      const a = getDefaultWebSettings();
      const b = getDefaultWebSettings();
      expect(sameWebSettings(a, b)).toBe(true);
    });

    it("returns false if engine order differs", () => {
      const a: WebSettings = {
        ...DEFAULT_WEB_SETTINGS,
        engines: ["duckduckgo", "brave"],
      };
      const b: WebSettings = {
        ...DEFAULT_WEB_SETTINGS,
        engines: ["brave", "duckduckgo"],
      };
      expect(sameWebSettings(a, b)).toBe(false);
    });

    it("returns false if any numeric field differs", () => {
      const base = getDefaultWebSettings();
      expect(sameWebSettings(base, { ...base, pageSize: 6 })).toBe(false);
      expect(sameWebSettings(base, { ...base, maxSnippetChars: 300 })).toBe(false);
      expect(sameWebSettings(base, { ...base, timeoutMs: 9000 })).toBe(false);
    });
  });
});
