import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserWindow } from "electron";
import { z } from "zod";

const windowStateSchema = z.object({
  width: z.number().int().positive().max(32767),
  height: z.number().int().positive().max(32767),
  maximized: z.boolean(),
});
type SavedWindowState = z.infer<typeof windowStateSchema>;
const DEFAULT_WINDOW_STATE: SavedWindowState = {
  width: 1200,
  height: 800,
  maximized: false,
};

export function loadWindowState(filePath: string): SavedWindowState {
  try {
    return windowStateSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

export function rememberWindowState(
  window: BrowserWindow,
  filePath: string,
): void {
  let maximized = window.isMaximized();
  window.on("maximize", () => {
    maximized = true;
  });
  window.on("unmaximize", () => {
    if (!window.isMinimized()) maximized = false;
  });
  window.on("close", () => {
    try {
      const { width, height } = window.getNormalBounds();
      const state = windowStateSchema.parse({
        width,
        height,
        maximized: window.isMinimized() ? maximized : window.isMaximized(),
      });
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
    } catch (error) {
      console.warn("Could not save window size.", error);
    }
  });
}
