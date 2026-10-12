import { OLLAMA_BASE_URL } from "../../shared/config";
import type { ChatMessage } from "../../shared/chat-ipc";
import type { ChatSettings } from "../../shared/config";

export type OllamaStatus =
  | { ok: true; version?: string; models: string[] }
  | { ok: false; error: string; models?: string[] };

export async function fetchOllamaStatus(
  timeoutMs = 3000,
): Promise<OllamaStatus> {
  try {
    const versionRes = await fetch(`${OLLAMA_BASE_URL}/api/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!versionRes.ok) {
      return { ok: false, error: `Ollama version HTTP ${versionRes.status}` };
    }
    const versionJson = (await versionRes.json()) as { version?: string };
    const tagsRes = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const tagsJson = tagsRes.ok
      ? ((await tagsRes.json()) as { models?: { name: string }[] })
      : { models: [] };
    const models = (tagsJson.models ?? []).map((m) => m.name);
    return { ok: true, version: versionJson.version, models };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Ollama unreachable";
    return { ok: false, error: message };
  }
}

export type OllamaChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type StreamHandlers = {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
};

export async function completeOllamaChat(
  messages: OllamaChatMessage[],
  settings: ChatSettings,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      think: settings.think,
      keep_alive: settings.keepAlive,
      options: {
        temperature: settings.temperature,
        num_ctx: settings.numCtx,
      },
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Ollama chat failed (${response.status}): ${text || response.statusText}`,
    );
  }

  const json = (await response.json()) as {
    message?: { content?: string };
    error?: string;
  };
  if (json.error) {
    throw new Error(json.error);
  }
  return json.message?.content ?? "";
}

export async function streamOllamaChat(
  messages: ChatMessage[],
  settings: ChatSettings,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  const body = {
    model: settings.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    think: settings.think,
    keep_alive: settings.keepAlive,
    options: {
      temperature: settings.temperature,
      num_ctx: settings.numCtx,
    },
  };

  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    handlers.onError(
      `Ollama chat failed (${response.status}): ${text || response.statusText}`,
    );
    return;
  }

  if (!response.body) {
    handlers.onError("Ollama returned an empty stream.");
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

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
        let chunk: {
          message?: { content?: string };
          done?: boolean;
          error?: string;
        };
        try {
          chunk = JSON.parse(trimmed) as typeof chunk;
        } catch {
          continue;
        }
        if (chunk.error) {
          handlers.onError(chunk.error);
          return;
        }
        if (chunk.message?.content) {
          full += chunk.message.content;
          handlers.onDelta(full);
        }
        if (chunk.done) {
          handlers.onDone();
          return;
        }
      }
    }
    handlers.onDone();
  } catch (error) {
    if (signal.aborted) return;
    handlers.onError(error instanceof Error ? error.message : "Stream failed");
  } finally {
    reader.releaseLock();
  }
}
