import type { ChatSettings } from "../../shared/config";
import {
  TITLE_SYSTEM_PROMPT,
  chatPlaceholderTitle,
  sanitizeGeneratedTitle,
} from "../../shared/thread-title";
import { completeOllamaChat } from "./ollama";
import { ollamaRequestGate } from "../runtime/ollama-gate";
import { BACKGROUND_REQUEST_PRIORITY } from "../runtime/request-gate";
import { routeUtterance } from "../../shared/local-commands";
import { randomUUID } from "node:crypto";
import { inferenceMeasurements } from "../runtime/prompt-eval";

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
  if (!userText || routeUtterance(userText).kind !== "model") return fallback;

  settings = { ...settings, think: false, temperature: 0.2 };
  let signal: AbortSignal | undefined;
  const measurement = inferenceMeasurements.begin({
    threadId,
    invocationId: randomUUID(),
    agentId: "title",
    work: "background",
    model: settings.model,
    numCtx: settings.numCtx,
  });
  try {
    const raw = await ollamaRequestGate.schedule(
      BACKGROUND_REQUEST_PRIORITY,
      () => {
        signal = AbortSignal.timeout(20_000);
        measurement.start();
        return completeOllamaChat(
          [
            { role: "system", content: TITLE_SYSTEM_PROMPT },
            { role: "user", content: userText.slice(0, 4000) },
          ],
          settings,
          signal,
          measurement.complete,
        );
      },
    );
    measurement.finish();
    return sanitizeGeneratedTitle(raw) ?? fallback;
  } catch (error) {
    measurement.finish(error, signal?.aborted);
    return fallback;
  }
}
