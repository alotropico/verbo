# Verbo Electron security

- **Main** owns Ollama, SQLite, and settings. **Preload** exposes narrow `assistantAI` + `verbo` APIs. **Renderer** is React + assistant-ui + Mantine. Styles: CSS modules + `globals.css` tokens. No Tailwind.
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. No raw `ipcRenderer` in React.
- IPC: validate sender frame + webContents; Zod-parse payloads; no generic command execution.
- Chat streams over `MessagePort` with serializable events only. Storage uses `ipcMain.handle` with fixed channels.
- External links: `setWindowOpenHandler` → `shell.openExternal`; deny new Electron windows.
- v2 authorizes exactly three model tools: `capabilities.list`, `capabilities.describe`, and `actions.invoke`. Electron main validates and executes them. The renderer has no tool executor and no auto-continuation. The MVP note that forbade model tools applied only before this authorized scope.
- No shell, PowerShell, JavaScript evaluation, MCP, or generic filesystem IPC. File effects go through registered actions and the path engine.
