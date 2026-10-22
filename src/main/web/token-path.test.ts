import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWebToken, webTokenPath } from "./token-path";

describe("web token path", () => {
  it("resolves token path using LOCALAPPDATA when available", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" };
    expect(webTokenPath(env, "C:\\Users\\test")).toBe("C:\\Users\\test\\AppData\\Local\\Verbo\\web-token");
  });

  it("resolves token path using homedir fallback when LOCALAPPDATA missing", () => {
    const env = {};
    const home = "C:\\Users\\test";
    expect(webTokenPath(env, home)).toBe(join(home, "AppData", "Local", "Verbo", "web-token"));
  });

  it("reads a valid token from file", () => {
    const dir = mkdtempSync(join(tmpdir(), "verbo-web-token-test-"));
    try {
      const file = join(dir, "web-token");
      writeFileSync(file, "0123456789abcdef0123456789abcdef", "utf8");
      expect(readWebToken(file)).toBe("0123456789abcdef0123456789abcdef");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null if token file is missing", () => {
    expect(readWebToken("nonexistent-file-path-xyz")).toBeNull();
  });

  it("returns null if token is shorter than 16 characters", () => {
    const dir = mkdtempSync(join(tmpdir(), "verbo-web-token-test-"));
    try {
      const file = join(dir, "web-token");
      writeFileSync(file, "short-token", "utf8");
      expect(readWebToken(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null if token contains newline characters", () => {
    const dir = mkdtempSync(join(tmpdir(), "verbo-web-token-test-"));
    try {
      const file = join(dir, "web-token");
      writeFileSync(file, "token-with-a-newline\n12345678", "utf8");
      expect(readWebToken(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
