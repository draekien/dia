// @effect-diagnostics-next-line nodeBuiltinImport:off -- electron-vite build config; runs at build time, not inside any Effect.
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ['electron'],
        input: {
          index: resolve('src/main/index.ts'),
          'pane-process/agent-session': resolve('src/main/pane-process/agent-session.ts')
        }
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@main': resolve('src/main')
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
