import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import { loadWindowState, rememberWindowState } from "./window-state";

const files: string[] = [];
function file(): string {
  const path = join(tmpdir(), `verbo-window-${randomUUID()}.json`);
  files.push(path);
  return path;
}
afterEach(() => {
  for (const path of files.splice(0)) rmSync(path, { force: true });
});

describe("remembered window size", () => {
  it("uses the existing defaults when state is absent or invalid", () => {
    const path = file();
    const defaults = { width: 1200, height: 800, maximized: false };
    expect(loadWindowState(path)).toEqual(defaults);
    for (const content of [
      "broken",
      '{"width":-1,"height":800,"maximized":false}',
    ]) {
      writeFileSync(path, content);
      expect(loadWindowState(path)).toEqual(defaults);
    }
  });
  it("keeps normal dimensions when closed maximized, and saves restored dimensions after unmaximizing", () => {
    const path = file();
    let maximized = false;
    let minimized = false;
    let bounds = { x: 0, y: 0, width: 960, height: 640 };
    const window = Object.assign(new EventEmitter(), {
      isMaximized: () => maximized,
      isMinimized: () => minimized,
      getNormalBounds: () => bounds,
    });
    rememberWindowState(window as unknown as BrowserWindow, path);
    maximized = true;
    window.emit("maximize");
    window.emit("close");
    expect(loadWindowState(path)).toEqual({
      width: 960,
      height: 640,
      maximized: true,
    });
    minimized = true;
    maximized = false;
    window.emit("unmaximize");
    window.emit("close");
    expect(loadWindowState(path).maximized).toBe(true);
    minimized = false;
    window.emit("unmaximize");
    bounds = { ...bounds, width: 1024, height: 720 };
    window.emit("close");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      width: 1024,
      height: 720,
      maximized: false,
    });
  });
});
