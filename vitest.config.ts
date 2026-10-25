import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@dia/plugin': resolve('src/host/plugin-api.ts'),
      '@dia/renderer-plugin': resolve('src/renderer/src/plugin-api.ts'),
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'plugins/**/*.test.ts',
      'plugins/**/*.test.tsx'
    ]
  }
})
