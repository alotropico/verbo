import { describe, expect, it } from 'vitest'
import { cssVariablesResolver, theme } from './mantine'

describe('shared Mantine tokens', () => {
  it('points Mantine CSS variables at existing semantic tokens', () => {
    const resolved = cssVariablesResolver(theme as never)
    expect(resolved.dark['--mantine-color-body']).toBe('var(--background)')
    expect(resolved.dark['--mantine-color-text']).toBe('var(--foreground)')
    expect(resolved.dark['--mantine-primary-color-filled']).toBe('var(--primary)')
    expect(resolved.light['--mantine-color-body']).toBe(resolved.dark['--mantine-color-body'])
    expect(resolved.variables['--mantine-radius-default']).toBe('var(--radius)')
  })

  it('uses semantic tokens for primary filled variants', () => {
    const colors = theme.variantColorResolver?.({
      color: undefined,
      theme: { primaryColor: 'blue' } as never,
      variant: 'filled'
    })
    expect(colors).toMatchObject({
      background: 'var(--primary)',
      color: 'var(--primary-foreground)'
    })
  })
})
