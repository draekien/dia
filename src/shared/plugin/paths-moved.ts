import { Option, Schema } from 'effect'

/**
 * A folder the Host moved from `from` to `to`, both absolute paths. A path owner receives each one
 * through `ctx.onPathsMoved` and rewrites the paths it stores with {@link relocatePath}.
 */
export const PathsMoved = Schema.Struct({ from: Schema.String, to: Schema.String })
export type PathsMoved = typeof PathsMoved.Type

const isWindowsPath = (path: string): boolean => path.includes('\\')

const startsWithFolder = (path: string, folder: string): boolean => {
  const [candidate, prefix] = isWindowsPath(folder)
    ? [path.toLowerCase(), folder.toLowerCase()]
    : [path, folder]
  if (candidate === prefix) return true
  if (!candidate.startsWith(prefix)) return false
  const next = candidate[prefix.length]
  return next === '/' || next === '\\'
}

/**
 * Where `path` is after `move`: `move.to` followed by the rest of `path` when `path` is `move.from`
 * or lies under it, none otherwise. On Windows paths (those containing `\`) the comparison
 * ignores case.
 */
export const relocatePath = (path: string, move: PathsMoved): Option.Option<string> =>
  startsWithFolder(path, move.from)
    ? Option.some(move.to + path.slice(move.from.length))
    : Option.none()
