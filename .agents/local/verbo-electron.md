# Verbo Electron security

- **Main** owns Ollama, SQLite, and settings. **Preload** exposes narrow `assistantAI` + `verbo` APIs. **Renderer** is React + assistant-ui + Mantine. Styles: CSS modules + `globals.css` tokens. No Tailwind.
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. No raw `ipcRenderer` in React.
- IPC: validate sender frame + webContents; Zod-parse payloads; no generic command execution.
- Chat streams over `MessagePort` with serializable events only. Storage uses `ipcMain.handle` with fixed channels.
- External links: `setWindowOpenHandler` → `shell.openExternal`; deny new Electron windows.
- No tools/MCP/shell/filesystem from the model in MVP.
