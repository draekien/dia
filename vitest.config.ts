import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@main': resolve('src/main')
    }
  },
  test: {
    include: ['src/**/*.test.ts']
  }
})
