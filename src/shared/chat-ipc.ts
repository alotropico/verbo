import type { ChatSettings } from './config'

export const ASSISTANT_STREAM_CHANNEL = 'verbo:assistant-stream'

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }

export type ChatRequest = {
  threadId: string
  system?: string
  messages: ChatMessage[]
  settings: ChatSettings
}

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'context_trimmed'; removedCount: number }

export type AssistantAI = {
  streamChat(
    request: ChatRequest,
    onEvent: (event: ChatEvent) => void
  ): () => void
}
