import type { ChatMessage } from '../../shared/chat-ipc'

/** Rough token budget: ~4 chars per token for Latin text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export type TrimResult = {
  messages: ChatMessage[]
  removedCount: number
}

export function trimMessagesForContext(
  messages: ChatMessage[],
  maxTokens: number
): TrimResult {
  if (messages.length === 0) {
    return { messages, removedCount: 0 }
  }

  const kept: ChatMessage[] = []
  let tokens = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const msgTokens = estimateTokens(msg.content) + 4
    if (kept.length > 0 && tokens + msgTokens > maxTokens) {
      break
    }
    kept.unshift(msg)
    tokens += msgTokens
  }

  const removedCount = messages.length - kept.length
  return { messages: kept, removedCount }
}
