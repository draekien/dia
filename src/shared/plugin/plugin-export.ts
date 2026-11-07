const PREFIX = '@dia-plugin/'

/** The plugin and the exported file (relative to its directory) an `@dia-plugin/...` specifier names. */
export interface PluginExportTarget {
  readonly plugin: string
  readonly file: string
}

/** Why an `@dia-plugin/...` specifier names no export, as a message that contains the specifier. */
export interface PluginExportRefusal {
  readonly message: string
}

/**
 * Resolves `specifier` against the files each plugin lists in `plugin.json` `exports`.
 * `exportsOf` returns a plugin's exports, or `undefined` for a plugin that does not exist.
 * Returns `undefined` when `specifier` does not start with `@dia-plugin/`; a
 * {@link PluginExportTarget} when `@dia-plugin/<plugin>/<file>` names a listed `<file>.ts`; and a
 * {@link PluginExportRefusal} otherwise. The Host's resolve hook, the renderer build and the
 * export tests all call it, so they share its rules and messages.
 */
export const resolvePluginExport = (
  specifier: string,
  exportsOf: (plugin: string) => ReadonlyArray<string> | undefined
): PluginExportTarget | PluginExportRefusal | undefined => {
  if (!specifier.startsWith(PREFIX)) return undefined
  const rest = specifier.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash < 1 || slash === rest.length - 1) {
    return {
      message: `Cannot import "${specifier}": name a plugin and a file, as @dia-plugin/<plugin>/<file>`
    }
  }
  const plugin = rest.slice(0, slash)
  const file = `${rest.slice(slash + 1)}.ts`
  const exports = exportsOf(plugin)
  if (exports === undefined) {
    return { message: `Cannot import "${specifier}": no plugin named "${plugin}"` }
  }
  if (!exports.includes(file)) {
    return { message: `Cannot import "${specifier}": plugin "${plugin}" does not export "${file}"` }
  }
  return { plugin, file }
}
