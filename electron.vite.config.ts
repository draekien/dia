// @effect-diagnostics-next-line nodeBuiltinImport:off -- electron-vite build config; runs at build time, not inside any Effect.
import { resolve } from 'node:path'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { diaPluginExports } from './vite/plugin-exports'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    ssr: {
      external: ['@anthropic-ai/claude-agent-sdk', 'effect']
    },
    build: {
      rollupOptions: {
        external: ['electron', 'tsx', 'tsx/esm/api', 'esbuild'],
        input: {
          index: resolve('src/main/index.ts'),
          host: resolve('src/host/index.ts'),
          'plugin-api': resolve('src/host/plugin-api.ts'),
          'dia-mcp': resolve('plugins/dia-tools/dia-mcp.ts')
        }
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src'),
        '@dia/renderer-plugin': resolve('src/renderer/src/plugin-api.ts'),
        '@dia/plugin': resolve('src/host/plugin-api.ts')
      }
    },
    plugins: [
      diaPluginExports(resolve('plugins')),
      react(),
      babel({
        presets: [reactCompilerPreset()]
      }),
      tailwindcss()
    ]
  }
})
