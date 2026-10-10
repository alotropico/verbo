import type { ChatSettings } from "../../shared/config";
import type { WelcomeLineRequest } from "../../shared/storage-ipc";
import { completeOllamaChat } from "./ollama";
import { ollamaRequestGate } from "../runtime/ollama-gate";
import { BACKGROUND_REQUEST_PRIORITY } from "../runtime/request-gate";

export const WELCOME_LINE_LIMIT = 140;

const WELCOME_LINE_SYSTEM_PROMPT = [
  "Write one short grammatical sentence.",
  "Finish the thought, then end with a period.",
  `Stay under ${WELCOME_LINE_LIMIT} characters by using fewer words, not by stopping mid-sentence.`,
  "Do not mention a date, a character count, or these instructions.",
  "Output only the sentence.",
].join(" ");

export function welcomeLinePrompt({
  verb,
  modifier,
}: WelcomeLineRequest): string {
  return [
    `Heading: "${verb} ${modifier}."`,
    "Write the one sentence that belongs under that heading.",
    "Do not repeat the heading. End with a period.",
  ].join(" ");
}

function rewriteWelcomeLinePrompt(draft: string): string {
  return [
    "Rewrite this as one shorter grammatical sentence with the same idea.",
    "Say fewer words so the sentence finishes on its own.",
    `Stay under ${WELCOME_LINE_LIMIT} characters.`,
    "End with a period. Do not stop mid-word. Do not mention a date.",
    draft,
  ].join("\n");
}

export function cleanWelcomeLine(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  text = text.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!text) return "";

  const finished = text.match(/^[^.!?]*[.!?]/);
  if (finished) {
    const sentence = finished[0].trim();
    if (sentence.length <= WELCOME_LINE_LIMIT) text = sentence;
  }

  text = text
    .replace(/[!?]+$/, "")
    .replace(/[,:;]+$/, "")
    .trim();
  if (!text) return "";
  if (!text.endsWith(".")) text = `${text}.`;
  return text;
}

async function requestWelcomeLine(
  user: string,
  settings: ChatSettings,
  signal: AbortSignal,
): Promise<string> {
  const raw = await ollamaRequestGate.schedule(
    BACKGROUND_REQUEST_PRIORITY,
    () =>
      completeOllamaChat(
        [
          { role: "system", content: WELCOME_LINE_SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        {
          ...settings,
          think: false,
        },
        signal,
      ),
  );
  return cleanWelcomeLine(raw);
}

export async function generateWelcomeLine(
  subject: WelcomeLineRequest,
  settings: ChatSettings,
): Promise<string> {
  try {
    const signal = AbortSignal.timeout(60_000);
    const first = await requestWelcomeLine(
      welcomeLinePrompt(subject),
      settings,
      signal,
    );
    if (first.endsWith(".") && first.length <= WELCOME_LINE_LIMIT) return first;
    const second = await requestWelcomeLine(
      rewriteWelcomeLinePrompt(first),
      settings,
      signal,
    );
    return second.endsWith(".") && second.length <= WELCOME_LINE_LIMIT
      ? second
      : "";
  } catch {
    return "";
  }
}
