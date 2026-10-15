# Turn instructions and command results

Electron main owns the chat turn. The renderer submits text and observes events through the preload bridge; it does not execute model tools.

## Instructions on every chat request

[`CORE_INSTRUCTIONS`](../src/main/runtime/context-builder.ts) is the mandatory system message. It includes these command rules:

- Never request the same command with the same arguments twice in a row, even with a different tool-call ID. Use the result already returned, including after failure.
- Provide a user-facing explanation of the command result even if the command fails, is denied, or cannot run.
- Describe the status actually returned. Claim success only with a confirming result; preserve reported counts and treat `null` as unknown.

`composeSystemPrompt` places these instructions before always-on memory. On-demand memories contribute availability counts until a memory command returns their text. `buildTurnContext` reserves space for the system message, latest user message, and tool results before retaining recent history. It returns a capacity error if mandatory context cannot fit, rather than sending a request without the instructions. Renderer-supplied system text is ignored.

[`runTurn`](../src/main/runtime/turn.ts) retains this system message across tool rounds, including continuation after an approval decision. Memory is frozen for the turn. Title generation is a separate request with its own prompt; these command instructions apply to chat inference.

## Runtime enforcement and limits

The model discovers commands with `capabilities.search`, `capabilities.list`, and `capabilities.describe`, then runs one with `actions.invoke`. The registry validates arguments and applies native policy. An approval decision returns a receipt to the same turn.

The runtime separately blocks a repeated tool name and serialized arguments within a turn, even if the tool-call ID changes. This guard is broader than the prompt's consecutive-repeat rule. It stops with `no_progress` and does not execute the repeated request. Argument serialization is literal; it does not normalize object key order.

A turn permits at most eight model rounds and twenty tool requests. Tool results remain in the context for the next model request. Answer text is published only after a complete response with no tool calls. Empty or unreadable replies produce a backend notice.

The core rules are model instructions. They do not synthesize an assistant reply if a model returns no text or the turn stops at a guard. Receipts and backend notices remain the authoritative evidence of what ran and what happened.

## Verification

```sh
pnpm test -- src/main/runtime/turn.test.ts src/main/runtime/ollama-wire.test.ts src/main/services/ollama-tool-stream.test.ts --maxWorkers=2
```

The tests check instruction retention with trimmed history and memory, stable context across tool rounds, receipt continuation after success/error/denial, repeated-request blocking, and Ollama tool-stream serialization. They use deterministic model fixtures; they do not measure a local model's compliance with the prompt.
