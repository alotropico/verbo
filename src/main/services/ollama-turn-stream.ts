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
  temperature?: number;
  seed?: number;
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
  options: { temperature: number; num_ctx: number; seed?: number };
} {
  return {
    model: settings.model,
    messages,
    ...(invocation.tools === false ? {} : { tools: PERMANENT_OLLAMA_TOOLS }),
    ...(invocation.format ? { format: invocation.format } : {}),
    stream: true as const,
    think: settings.think,
    keep_alive: settings.keepAlive,
    options: ollamaOptions(settings, {
      temperature: invocation.temperature,
      seed: invocation.seed,
    }),
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
  const stallMs = invocation.deadlineMs ?? 120_000;
  const stall = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetStall = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      stall.abort(new DOMException("Ollama stream stalled.", "TimeoutError"));
    }, stallMs);
  };
  resetStall();
  const combinedSignal = AbortSignal.any([signal, stall.signal]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const onAbort = (): void => {
    reader?.cancel(combinedSignal.reason).catch(() => undefined);
  };
  combinedSignal.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ollamaChatBody(messages, settings, invocation)),
      signal: combinedSignal,
    });

    resetStall();

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Ollama chat failed (${response.status}): ${text || response.statusText}`,
      );
    }
    if (!response.body) throw new Error("Ollama returned an empty stream.");

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const chunks: unknown[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw abortError();
      if (stall.signal.aborted) {
        throw stall.signal.reason instanceof Error
          ? stall.signal.reason
          : new DOMException("Ollama stream stalled.", "TimeoutError");
      }
      if (done) break;
      resetStall();
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
    if (signal.aborted) throw abortError();
    if (stall.signal.aborted) {
      throw stall.signal.reason instanceof Error
        ? stall.signal.reason
        : new DOMException("Ollama stream stalled.", "TimeoutError");
    }
    return chunks;
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (stall.signal.aborted) {
      throw stall.signal.reason instanceof Error
        ? stall.signal.reason
        : new DOMException("Ollama stream stalled.", "TimeoutError");
    }
    throw error instanceof Error ? error : new Error("Stream failed");
  } finally {
    combinedSignal.removeEventListener("abort", onAbort);
    if (timer !== undefined) clearTimeout(timer);
    if (reader) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
