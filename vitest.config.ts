import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs']
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  }
})
