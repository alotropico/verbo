import { describe, expect, it } from 'vitest'
import {
  chatPlaceholderTitle,
  sanitizeGeneratedTitle
} from './thread-title'

describe('chatPlaceholderTitle', () => {
  it('strips the local-id prefix', () => {
    expect(chatPlaceholderTitle('__LOCALID_Ab3xY9Z')).toBe('Chat Ab3xY9Z')
  })

  it('uses the id as-is when there is no prefix', () => {
    expect(chatPlaceholderTitle('thread-1')).toBe('Chat thread-1')
  })
})

describe('sanitizeGeneratedTitle', () => {
  it('returns the first non-empty line without quotes', () => {
    expect(sanitizeGeneratedTitle('"Garden plan"\nextra')).toBe('Garden plan')
  })

  it('strips think blocks and title labels', () => {
    expect(sanitizeGeneratedTitle('<think>hm</think>\nTitle: Weekend trip')).toBe(
      'Weekend trip'
    )
  })

  it('returns undefined for blank output', () => {
    expect(sanitizeGeneratedTitle('   \n  ')).toBeUndefined()
  })
})
