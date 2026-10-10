import { MantineProvider } from '@mantine/core'
import type { ReactNode } from 'react'
import { cssVariablesResolver, theme } from './mantine'

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
      forceColorScheme="dark"
    >
      {children}
    </MantineProvider>
  )
}
