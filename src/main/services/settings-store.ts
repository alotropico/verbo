import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { DEFAULT_CHAT_SETTINGS, type ChatSettings } from '../../shared/config'
import { chatSettingsSchema } from '../../shared/storage-ipc'

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): ChatSettings {
  try {
    const raw = readFileSync(settingsPath(), 'utf8')
    const parsed = chatSettingsSchema.parse(JSON.parse(raw))
    return parsed
  } catch {
    return { ...DEFAULT_CHAT_SETTINGS }
  }
}

export function saveSettings(settings: ChatSettings): ChatSettings {
  const parsed = chatSettingsSchema.parse(settings)
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(parsed, null, 2), 'utf8')
  return parsed
}
