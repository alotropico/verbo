import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CHAT_SETTINGS } from '../../shared/config'

vi.mock('./ollama', () => ({
  completeOllamaChat: vi.fn()
}))

import { completeOllamaChat } from './ollama'
import { generateWelcomeLine, WELCOME_LINE_LIMIT } from './welcome-line'

const completeOllamaChatMock = vi.mocked(completeOllamaChat)

const LONG_SENTENCE =
  'Walk the long way home and tell the streetlight what you refused to say out loud today then keep going until the words run past the place where a sentence should have stopped'

describe('generateWelcomeLine', () => {
  beforeEach(() => {
    completeOllamaChatMock.mockReset()
  })

  it('asks for a grammatical sentence with no date and turns thinking on', async () => {
    completeOllamaChatMock.mockResolvedValue('Leave one window open tonight.')
    await expect(
      generateWelcomeLine('Absquatulate agley', { ...DEFAULT_CHAT_SETTINGS, think: false })
    ).resolves.toBe('Leave one window open tonight.')
    const [messages, settings] = completeOllamaChatMock.mock.calls[0]!
    expect(messages[0]).toEqual({
      role: 'system',
      content:
        'Write one short grammatical sentence. Finish the thought, then end with a period. Stay under 140 characters by using fewer words, not by stopping mid-sentence. Do not mention a date, a character count, or these instructions. Output only the sentence.'
    })
    expect(messages[1]).toEqual({
      role: 'user',
      content:
        'Tell me something that makes people be Absquatulate agley. Write one grammatical sentence that ends with a period.'
    })
    expect(messages[1]?.content).not.toMatch(/October|Saturday|2026/)
    expect(settings.think).toBe(true)
    expect(completeOllamaChatMock).toHaveBeenCalledOnce()
  })

  it('adds a period when the model leaves it off', async () => {
    completeOllamaChatMock.mockResolvedValue('Leave the lamp lit tonight')
    await expect(generateWelcomeLine('Vellicate erstwhile', DEFAULT_CHAT_SETTINGS)).resolves.toBe(
      'Leave the lamp lit tonight.'
    )
  })

  it('asks for a shorter finished sentence instead of cutting', async () => {
    const fitted = 'Walk home the long way and tell the streetlight.'
    expect(LONG_SENTENCE.length).toBeGreaterThan(WELCOME_LINE_LIMIT)
    expect(fitted.length).toBeLessThanOrEqual(WELCOME_LINE_LIMIT)
    expect(fitted.endsWith('.')).toBe(true)
    completeOllamaChatMock.mockResolvedValueOnce(LONG_SENTENCE).mockResolvedValueOnce(fitted)
    await expect(generateWelcomeLine('Lucubrate askance', DEFAULT_CHAT_SETTINGS)).resolves.toBe(
      fitted
    )
    expect(completeOllamaChatMock).toHaveBeenCalledTimes(2)
    const secondUser = completeOllamaChatMock.mock.calls[1]![0][1]
    expect(secondUser?.content).toContain(LONG_SENTENCE)
    expect(secondUser?.content).toContain('End with a period')
    expect(secondUser?.content).toContain('140')
  })

  it('drops a sentence that is still too long instead of cutting it', async () => {
    completeOllamaChatMock.mockResolvedValue(LONG_SENTENCE)
    await expect(generateWelcomeLine('Lucubrate askance', DEFAULT_CHAT_SETTINGS)).resolves.toBe('')
  })

  it('hides a think block and keeps the sentence', async () => {
    completeOllamaChatMock.mockResolvedValue(
      '<think>sixty is enough</think>\nLeave the lamp lit tonight.'
    )
    await expect(generateWelcomeLine('Vellicate erstwhile', DEFAULT_CHAT_SETTINGS)).resolves.toBe(
      'Leave the lamp lit tonight.'
    )
  })

  it('returns an empty string when Ollama fails', async () => {
    completeOllamaChatMock.mockRejectedValue(new Error('offline'))
    await expect(generateWelcomeLine('Vellicate erstwhile', DEFAULT_CHAT_SETTINGS)).resolves.toBe(
      ''
    )
  })
})
