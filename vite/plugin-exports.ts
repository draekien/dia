// @effect-diagnostics-next-line nodeBuiltinImport:off -- a Vite plugin's resolveId runs at build time, not inside any Effect.
import { existsSync, readFileSync } from 'node:fs'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a Vite plugin's resolveId runs at build time, not inside any Effect.
import { join } from 'node:path'
import { Schema } from 'effect'
import type { Plugin } from 'vite'
import { PluginManifest } from '../src/shared/plugin/manifest'
import { resolvePluginExport } from '../src/shared/plugin/plugin-export'

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(PluginManifest))

/**
 * A Vite plugin that resolves `@dia-plugin/<name>/<file>` to `<pluginsDir>/<name>/<file>.ts` when
 * `<pluginsDir>/<name>/plugin.json` lists `<file>.ts` in `exports`, and fails the build with
 * `resolvePluginExport`'s message otherwise. Add it to the renderer build; `pluginsDir` is the
 * absolute path of the repo's `plugins` directory.
 */
export const diaPluginExports = (pluginsDir: string): Plugin => {
  const exportsOf = (plugin: string): ReadonlyArray<string> | undefined => {
    const manifestPath = join(pluginsDir, plugin, 'plugin.json')
    if (!existsSync(manifestPath)) return undefined
    return decodeManifest(readFileSync(manifestPath, 'utf8')).exports ?? []
  }
  return {
    name: 'dia-plugin-exports',
    enforce: 'pre',
    resolveId(source) {
      const target = resolvePluginExport(source, exportsOf)
      if (target === undefined) return null
      if ('message' in target) this.error(target.message)
      return join(pluginsDir, target.plugin, target.file)
    }
  }
}
