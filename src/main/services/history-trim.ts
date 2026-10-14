import type { ChatMessage } from "../../shared/chat-ipc";
import { estimateTokens } from "../../shared/token-estimate";
export { estimateTokens } from "../../shared/token-estimate";

export type TrimResult = {
  messages: ChatMessage[];
  removedCount: number;
};

export function trimMessagesForContext(
  messages: ChatMessage[],
  maxTokens: number,
): TrimResult {
  if (messages.length === 0) {
    return { messages, removedCount: 0 };
  }

  const kept: ChatMessage[] = [];
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const msgTokens = estimateTokens(msg.content) + 4;
    if (kept.length > 0 && tokens + msgTokens > maxTokens) {
      break;
    }
    kept.unshift(msg);
    tokens += msgTokens;
  }

  const removedCount = messages.length - kept.length;
  return { messages: kept, removedCount };
}
