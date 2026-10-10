import type { ChatSettings } from "../../shared/config";
import {
  TITLE_SYSTEM_PROMPT,
  chatPlaceholderTitle,
  sanitizeGeneratedTitle,
} from "../../shared/thread-title";
import { completeOllamaChat } from "./ollama";
import { ollamaRequestGate } from "../runtime/ollama-gate";
import { BACKGROUND_REQUEST_PRIORITY } from "../runtime/request-gate";

export type TitleSourceMessage = {
  role: "user" | "assistant";
  content: string;
};

export async function generateThreadTitle(
  threadId: string,
  messages: TitleSourceMessage[],
  settings: ChatSettings,
): Promise<string> {
  const fallback = chatPlaceholderTitle(threadId);
  const userText = messages
    .find((message) => message.role === "user")
    ?.content.trim();
  if (!userText) return fallback;

  try {
    const raw = await ollamaRequestGate.schedule(
      BACKGROUND_REQUEST_PRIORITY,
      () =>
        completeOllamaChat(
          [
            { role: "system", content: TITLE_SYSTEM_PROMPT },
            { role: "user", content: userText.slice(0, 4000) },
          ],
          {
            ...settings,
            think: false,
            temperature: 0.2,
            numCtx: Math.min(settings.numCtx, 2048),
          },
          AbortSignal.timeout(20_000),
        ),
    );
    return sanitizeGeneratedTitle(raw) ?? fallback;
  } catch {
    return fallback;
  }
}
