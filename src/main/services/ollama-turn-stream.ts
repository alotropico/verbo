import { OLLAMA_BASE_URL } from "../../shared/config";
import type { ChatSettings } from "../../shared/config";
import {
  PERMANENT_OLLAMA_TOOLS,
  type OllamaWireMessage,
} from "../runtime/ollama-wire";
import { notePromptEval } from "../runtime/prompt-eval";

function abortError(): Error {
  const error = new Error("The turn was cancelled.");
  error.name = "AbortError";
  return error;
}

export function ollamaChatBody(
  messages: readonly OllamaWireMessage[],
  settings: ChatSettings,
): {
  model: string;
  messages: readonly OllamaWireMessage[];
  tools: typeof PERMANENT_OLLAMA_TOOLS;
  stream: true;
  think: boolean;
  keep_alive: string;
  options: { temperature: number; num_ctx: number };
} {
  return {
    model: settings.model,
    messages,
    tools: PERMANENT_OLLAMA_TOOLS,
    stream: true as const,
    think: settings.think,
    keep_alive: settings.keepAlive,
    options: {
      temperature: settings.temperature,
      num_ctx: settings.numCtx,
    },
  };
}

export async function streamOllamaTurn(
  messages: readonly OllamaWireMessage[],
  settings: ChatSettings,
  signal: AbortSignal,
  onText: (snapshot: string) => void,
): Promise<unknown[]> {
  if (signal.aborted) throw abortError();
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ollamaChatBody(messages, settings)),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Ollama chat failed (${response.status}): ${text || response.statusText}`,
    );
  }
  if (!response.body) throw new Error("Ollama returned an empty stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const chunks: unknown[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let chunk: unknown;
        try {
          chunk = JSON.parse(trimmed) as unknown;
        } catch {
          chunks.push({ parseError: true, raw: trimmed });
          continue;
        }
        chunks.push(chunk);
        if (
          typeof chunk === "object" &&
          chunk !== null &&
          "error" in chunk &&
          typeof chunk.error === "string"
        ) {
          throw new Error(chunk.error);
        }
        const message =
          typeof chunk === "object" &&
          chunk !== null &&
          "message" in chunk &&
          typeof chunk.message === "object" &&
          chunk.message !== null
            ? chunk.message
            : undefined;
        if (
          message &&
          "content" in message &&
          typeof message.content === "string" &&
          message.content
        ) {
          content += message.content;
          onText(content);
        }
        if (
          typeof chunk === "object" &&
          chunk !== null &&
          "done" in chunk &&
          chunk.done === true
        ) {
          if (
            "prompt_eval_count" in chunk &&
            typeof chunk.prompt_eval_count === "number"
          ) {
            notePromptEval(chunk.prompt_eval_count);
          }
          return chunks;
        }
      }
    }
    return chunks;
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error instanceof Error ? error : new Error("Stream failed");
  } finally {
    reader.releaseLock();
  }
}
