import type { GitFileChange, PluginControl, PluginInfo } from '@dia/plugin'
import { Effect, Option } from 'effect'

const normalise = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '')

/**
 * The path of `path` relative to `directory`, with forward slashes, when `path` is `directory` or
 * lies inside it (`''` for `directory` itself); `None` otherwise. Case is ignored, so a Windows
 * path matches whatever drive-letter case it was written in.
 */
export const relativeInside = (directory: string, path: string): Option.Option<string> => {
  const base = normalise(directory)
  const target = normalise(path)
  if (target.toLowerCase() === base.toLowerCase()) return Option.some('')
  const prefix = `${base}/`
  return target.toLowerCase().startsWith(prefix.toLowerCase())
    ? Option.some(target.slice(prefix.length))
    : Option.none()
}

/**
 * `relative` (forward slashes) joined to `directory` with the separator `directory` is written
 * with.
 */
export const joinInside = (directory: string, relative: string) => {
  const separator = directory.includes('\\') ? '\\' : '/'
  return relative === ''
    ? directory
    : `${directory.replace(/[\\/]+$/, '')}${separator}${relative.replaceAll('/', separator)}`
}

const containsFile = (folder: string, files: ReadonlyArray<GitFileChange>) =>
  files.some((file) => folder === '' || file.path === folder || file.path.startsWith(`${folder}/`))

/**
 * The names of the plugins in `list` whose source folder lies inside the repository working tree
 * `directory` and holds one of `files` (paths relative to that working tree).
 */
export const pluginsTouched = (
  list: ReadonlyArray<PluginInfo>,
  directory: string,
  files: ReadonlyArray<GitFileChange>
): ReadonlyArray<string> =>
  list.flatMap((info) =>
    Option.match(relativeInside(directory, info.root), {
      onNone: () => [],
      onSome: (folder) => (containsFile(folder, files) ? [info.name] : [])
    })
  )

/** The plugins in `list` loaded from an override folder inside `directory`, with that folder relative to it. */
export const overridesInside = (
  list: ReadonlyArray<PluginInfo>,
  directory: string
): ReadonlyArray<{ readonly name: string; readonly folder: string }> =>
  list.flatMap((info) =>
    info.origin !== 'override'
      ? []
      : Option.match(relativeInside(directory, info.root), {
          onNone: () => [],
          onSome: (folder) => [{ name: info.name, folder }]
        })
  )

const RELOADED_LAST = new Set(['dia-creator', 'dia-runs'])

/**
 * Reloads the plugins in `names` other than `dia-creator` and `dia-runs` and waits for them, then
 * starts the `dia-creator` and `dia-runs` reloads without waiting: reloading either plugin closes
 * the scope of the dia-creator call that asked for it. Call it last, after the caller's other work.
 */
export const reloadPlugins = Effect.fn('Creator.reloadPlugins')(function* (
  plugins: Pick<PluginControl, 'reload'>,
  names: ReadonlyArray<string>
) {
  const unique = [...new Set(names)]
  const now = unique.filter((name) => !RELOADED_LAST.has(name))
  const last = unique.filter((name) => RELOADED_LAST.has(name))
  yield* Effect.logInfo('Reloading plugins a Creator change touched', { now, last })
  yield* Effect.forEach(now, (name) => plugins.reload(name), { discard: true })
  yield* Effect.forEach(last, (name) => plugins.reload(name), { discard: true }).pipe(
    Effect.forkDetach
  )
})
