import { OLLAMA_BASE_URL } from "../../shared/config";
import type { ChatSettings } from "../../shared/config";
import {
  PERMANENT_OLLAMA_TOOLS,
  type OllamaWireMessage,
} from "../runtime/ollama-wire";
import { ollamaOptions } from "./ollama-options";

function abortError(): Error {
  const error = new Error("The turn was cancelled.");
  error.name = "AbortError";
  return error;
}

export type OllamaInvocationOptions = {
  tools?: boolean;
  format?: Record<string, unknown>;
  deadlineMs?: number;
  onCompletion?: (chunk: unknown) => void;
};

export function ollamaChatBody(
  messages: readonly OllamaWireMessage[],
  settings: ChatSettings,
  invocation: OllamaInvocationOptions = {},
): {
  model: string;
  messages: readonly OllamaWireMessage[];
  tools?: typeof PERMANENT_OLLAMA_TOOLS;
  format?: Record<string, unknown>;
  stream: true;
  think: boolean;
  keep_alive: string;
  options: { temperature: number; num_ctx: number };
} {
  return {
    model: settings.model,
    messages,
    ...(invocation.tools === false ? {} : { tools: PERMANENT_OLLAMA_TOOLS }),
    ...(invocation.format ? { format: invocation.format } : {}),
    stream: true as const,
    think: settings.think,
    keep_alive: settings.keepAlive,
    options: ollamaOptions(settings),
  };
}

export async function streamOllamaTurn(
  messages: readonly OllamaWireMessage[],
  settings: ChatSettings,
  signal: AbortSignal,
  onText: (snapshot: string) => void,
  invocation: OllamaInvocationOptions = {},
): Promise<unknown[]> {
  if (signal.aborted) throw abortError();
  signal = AbortSignal.any([
    signal,
    AbortSignal.timeout(invocation.deadlineMs ?? 120_000),
  ]);
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ollamaChatBody(messages, settings, invocation)),
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
          invocation.onCompletion?.(chunk);
          return chunks;
        }
      }
    }
    return chunks;
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error instanceof Error ? error : new Error("Stream failed");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
