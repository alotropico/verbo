export const LOCAL_THREAD_ID_PREFIX = '__LOCALID_'

export const TITLE_SYSTEM_PROMPT =
  'Reply with a short chat title only. 2-6 words. No quotes. No explanation.'

export function chatPlaceholderTitle(id: string): string {
  const short = id.startsWith(LOCAL_THREAD_ID_PREFIX)
    ? id.slice(LOCAL_THREAD_ID_PREFIX.length)
    : id
  return `Chat ${short}`
}

export function sanitizeGeneratedTitle(raw: string): string | undefined {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  text = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? ''
  text = text.replace(/^["'`]+|["'`]+$/g, '').trim()
  text = text.replace(/^(title|name)\s*:\s*/i, '').trim()
  if (!text) return undefined
  if (text.length > 80) {
    return `${text.slice(0, 77)}…`
  }
  return text
}
