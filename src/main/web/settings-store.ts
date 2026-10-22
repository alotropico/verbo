import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import { recoverWebSettings, webSettingsSchema, type WebSettings } from "../../shared/web-settings";

export function defaultWebSettingsPath(): string {
  try {
    return join(app.getPath("userData"), "web-settings.json");
  } catch {
    return "web-settings.json";
  }
}

export function loadWebSettings(filePath = defaultWebSettingsPath()): WebSettings {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return recoverWebSettings(raw);
  } catch {
    return recoverWebSettings(undefined);
  }
}

export function saveWebSettings(settings: WebSettings, filePath = defaultWebSettingsPath()): WebSettings {
  const parsed = webSettingsSchema.parse(settings);
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tempPath = join(dir, `.web-settings.${randomUUID()}.tmp`);
  writeFileSync(tempPath, JSON.stringify(parsed, null, 2), "utf8");
  renameSync(tempPath, filePath);

  return {
    ...parsed,
    engines: [...parsed.engines],
  };
}
