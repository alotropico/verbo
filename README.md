# Verbo

**Think out loud.**

Verbo is a local AI chat app for exploring ideas, making things, and questioning assumptions. It runs as an Electron desktop app, uses Ollama for inference, and saves conversations on your machine. A textured background, translucent surfaces, and restrained color keep the interface quiet while giving it a little character. No hosted AI account or API key is required.

## Features

### Conversations

- **Streamed answers:** replies appear as they arrive, with a stop control for ongoing generation.
- **Editable starting points:** “Explore an idea,” “Create something,” and “Challenge a belief” fill the composer with a prompt you can change before sending.
- **Iteration:** edit a user message, regenerate an assistant response, and navigate alternative message branches using assistant-ui controls.
- **Markdown:** answers support headings, lists, tables, links, blockquotes, and fenced code blocks through GitHub-flavored Markdown.
- **Copy and export:** copy an answer or code block, or export an assistant message as Markdown from its action menu.
- **A persistent composer:** the input stays within reach as a conversation grows, with a control to return to the latest messages.

### Conversation history

Create, switch, search by title, rename, archive, and delete conversations from the sidebar. Threads and messages are stored in SQLite and loaded when you return to a conversation.

Titles are generated locally from the first user message using the selected Ollama model. Title generation uses a separate, non-streaming request with thinking disabled and a short timeout. If it fails or produces an unusable title, the conversation keeps its fallback `Chat …` title.

Long conversations use a rough character-based token estimate to select recent messages for a request budget of 75% of the configured context window. The latest message is always retained, even if it exceeds that estimate. This trims the history sent to the model; it does not delete saved messages or summarize them.

### Model settings and status

The settings panel lets you select an installed model and adjust thinking mode, temperature, and context size. Changes are saved locally and read before the next chat request.

| Setting        | Default             | Behavior                                                                                      |
| -------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| Model          | `qwen3.5:4b-q4_K_M` | Accepts an Ollama model tag; the model must already be installed.                             |
| Thinking mode  | On                  | Sends the `think` option to Ollama; support depends on the model.                             |
| Temperature    | `0.4`               | Sampling randomness, from `0` to `2`.                                                         |
| Context window | `8192`              | Sends `num_ctx` to Ollama; accepts `512`–`131072` tokens. Larger windows require more memory. |
| Keep alive     | `5m`                | Sends `keep_alive` to Ollama. Stored in settings, but not currently exposed in the form.      |

The header polls Ollama every 15 seconds and shows the configured model's readiness. Its tooltip provides the full model tag or connection details.

### Visual language and controls

The interface uses a dark, textured canvas with glass-like panels, fine borders, soft shadows, and subtle glows. Mint marks primary actions and readiness, warm accents identify creative prompts, and lilac accents identify challenge prompts and reasoning components. Color supports the controls without crowding the conversation.

The sidebar can fold away, the layout adapts to smaller windows, and surface transitions include reduced-motion handling.

| Shortcut               | Action                    |
| ---------------------- | ------------------------- |
| `Enter`                | Send a message.           |
| `Shift + Enter`        | Insert a line break.      |
| `Ctrl + B` / `Cmd + B` | Toggle the sidebar.       |
| `Escape`               | Close the settings modal. |

## Setup

### Prerequisites

- Node.js `22.12` or newer, compatible with the installed Vite toolchain.
- pnpm.
- Ollama, either available on `PATH` or already serving at `http://127.0.0.1:11434`.
- Enough RAM or VRAM for the model and context window you choose.

### Install and run

From the repository root:

```sh
pnpm install
ollama pull qwen3.5:4b-q4_K_M
pnpm start
```

`pnpm start` runs [the development launcher](scripts/start.mjs), which:

1. Checks whether Ollama is reachable and reuses an existing server.
2. Starts `ollama serve` if needed and waits up to 30 seconds for it to become ready.
3. Checks that the startup model is installed and prints an `ollama pull` command if it is missing.
4. Launches electron-vite and the Electron window.

When development exits, the launcher stops an Ollama process it started itself. It leaves a pre-existing server running.

The renderer development server uses port `5273`. Use the Electron window for the application: its chat, history, and settings depend on the preload bridge and cannot run independently in a browser tab.

### Use another model

Install the desired model with `ollama pull <model-tag>`, then enter its exact tag in the app's settings panel.

The launcher checks `VERBO_MODEL` when it is set, otherwise it checks the default model. This environment variable changes **startup verification only**; it does not change the app's saved model selection. To launch with only an alternative model installed, set the variable as well as selecting that model in the app.

PowerShell:

```powershell
$env:VERBO_MODEL = 'your-installed-model:tag'
pnpm start
```

POSIX shell:

```sh
VERBO_MODEL='your-installed-model:tag' pnpm start
```

`pnpm dev` launches electron-vite directly and skips the Ollama startup checks. It is useful when you manage the Ollama server yourself.

### Local data

Verbo stores application data in Electron's platform-specific `app.getPath('userData')` directory:

| File            | Contents                                       |
| --------------- | ---------------------------------------------- |
| `verbo.sqlite`  | Conversation metadata and serialized messages. |
| `settings.json` | Validated model and generation settings.       |

Model inference and title generation use the local Ollama endpoint. Downloading dependencies and models requires network access; chat uses the installed model once Ollama is running.

## Stack

| Layer                     | Technology                                      | Role                                                                              |
| ------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| Desktop                   | Electron 39                                     | Window lifecycle, isolated preload bridge, and main-process services.             |
| UI                        | React 19 and TypeScript 5                       | Application shell and typed components.                                           |
| Chat                      | assistant-ui                                    | Thread state, streaming runtime, message actions, branches, and history adapters. |
| Components and forms      | Mantine 9                                       | Layout, controls, dialogs, tooltips, and uncontrolled forms.                      |
| Styling                   | CSS modules and PostCSS                         | Component styles and shared semantic tokens.                                      |
| Icons                     | Lucide React                                    | Interface icons alongside Verbo's SVG mark.                                       |
| Markdown                  | `@assistant-ui/react-markdown` and `remark-gfm` | Message rendering and GitHub-flavored Markdown.                                   |
| Inference                 | Ollama HTTP API                                 | Local chat streaming, title generation, and model status.                         |
| Persistence               | SQLite via `node:sqlite`                        | Conversation storage in Electron's main process.                                  |
| Validation                | Zod                                             | Settings and IPC payload schemas.                                                 |
| Development and packaging | electron-vite, Vite, and electron-builder       | Development builds, renderer updates, and packaging scripts.                      |
| Verification              | Vitest, TypeScript, ESLint, and Prettier        | Tests, type checks, linting, and formatting.                                      |

Dependency versions and scripts are defined in [package.json](package.json), with resolved versions in [pnpm-lock.yaml](pnpm-lock.yaml).

## Architecture and patterns

### Process boundaries

```text
React renderer
  → typed preload APIs
  → Electron main-process IPC handlers
  → Ollama / SQLite / settings.json
```

The renderer handles presentation and assistant-ui state. The main process owns filesystem access, persistence, and Ollama requests. The sandboxed preload exposes a narrow API through `contextBridge`:

- `window.assistantAI.streamChat` starts a chat stream and returns a cleanup function.
- `window.verbo.storage` manages threads and message history.
- `window.verbo.settings` reads and saves generation settings.
- `window.verbo.ollama.status` checks server and model readiness.

The window enables context isolation and sandboxing, disables renderer Node integration, and applies a Content Security Policy. Main-process handlers verify the sender and frame; request payloads are validated with Zod.

### Streaming and runtime adapters

[VerboRuntimeProvider](src/renderer/src/runtime/VerboRuntimeProvider.tsx) combines assistant-ui's `useLocalRuntime` with `useRemoteThreadListRuntime`. Here, the thread-list adapter uses local SQLite storage through IPC.

The [chat model adapter](src/renderer/src/runtime/chat-model-adapter.ts) serializes text messages and turns MessagePort events into an async generator consumed by assistant-ui. Ollama's newline-delimited JSON stream is accumulated into text snapshots. Closing the port cancels the corresponding request through an `AbortController`.

The [thread-list adapter](src/renderer/src/runtime/thread-list-adapter.tsx) supplies thread operations, generated titles, and per-thread history adapters. Message payloads are stored as JSON with parent references, keeping persistence separate from the chat components.

The current inference adapter handles text chat. Attachment, voice, feedback, and tool-rendering components exist in the UI catalog, but their adapters are not connected. Ollama's separate thinking field is not currently forwarded as a reasoning message part; the thinking setting still reaches the model.

### Shared contracts and services

[src/shared](src/shared) contains IPC channel names, request and event types, validation schemas, defaults, and title helpers. The preload and main process use these shared contracts rather than duplicating channel strings or settings shapes.

[src/main/services](src/main/services) separates Ollama access, conversations, settings, context trimming, and title generation. Database initialization and schema migration live in [src/main/db/database.ts](src/main/db/database.ts).

### One semantic theme

[globals.css](src/renderer/src/assets/globals.css) is the source of truth for semantic colors, radii, surfaces, shadows, and glows. [theme/mantine.ts](src/renderer/src/theme/mantine.ts) maps these tokens into Mantine's CSS variables and component styles. The [ThemeProvider](src/renderer/src/theme/ThemeProvider.tsx) currently forces the dark scheme.

Renderer components use adjacent CSS modules and the shared `cx` helper for class composition. New styles should consume the semantic tokens, and global Mantine changes should go through the existing theme. Keep one palette and do not introduce Tailwind.

The settings form uses Mantine's uncontrolled mode, `form.key(...)`, `getInputProps(...)`, and the shared Zod settings schema. Validation is repeated in the main process before persistence.

### Project layout

```text
scripts/start.mjs                Ollama-aware development launcher
src/main/                       Electron lifecycle, IPC, services, and SQLite
src/preload/                    Isolated renderer API bridge
src/shared/                     IPC contracts, schemas, and shared helpers
src/renderer/src/
  assets/globals.css            Semantic design tokens
  components/                   App controls and assistant-ui elements
  runtime/                      Chat, thread-list, and history adapters
  theme/                        Mantine theme and provider
  App.tsx                       Desktop shell
```

## Development and builds

| Command             | Purpose                                                     |
| ------------------- | ----------------------------------------------------------- |
| `pnpm start`        | Check/start Ollama, verify a model, and launch development. |
| `pnpm dev`          | Launch development without Ollama preflight.                |
| `pnpm typecheck`    | Check the main/preload and renderer TypeScript projects.    |
| `pnpm test`         | Run Vitest tests.                                           |
| `pnpm lint`         | Run repository-wide ESLint.                                 |
| `pnpm format`       | Format the repository with Prettier; this writes files.     |
| `pnpm build`        | Type-check and produce application bundles in `out/`.       |
| `pnpm build:unpack` | Build and create an unpacked application.                   |
| `pnpm build:win`    | Build and package for Windows.                              |
| `pnpm build:mac`    | Build and package for macOS.                                |
| `pnpm build:linux`  | Build and package for Linux.                                |

Tests currently cover history trimming, title sanitization and generation, and semantic Mantine theme mappings. UI changes also need inspection in the Electron app.

Packaging output goes to `dist/`. [electron-builder.yml](electron-builder.yml) still contains template product names and publishing metadata, and its macOS configuration references `build/entitlements.mac.plist`, which is not included in this checkout. Configure these details and provide the required resources before distributing a release. Packaged apps require an available Ollama server and installed model; the automatic server launcher belongs to the development script.
