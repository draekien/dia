import type { ProjectEntry } from '@shared/domain/attachment'
import { Context, Effect, FileSystem, Layer, Option, Path } from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { GitKey } from './git-seam'

/** The most entries {@link ProjectEntries.list} returns for one directory. */
export const PROJECT_ENTRY_LIMIT = 20_000

const SKIPPED_SEGMENTS = new Set(['.git', 'node_modules'])

/**
 * The entries for `files`, the `/`-separated relative paths `Git.listFiles` returns: every
 * directory those paths lie in, then every file, each group in path order, at most `limit` in all.
 */
export const entriesFromFiles = (
  files: ReadonlyArray<string>,
  limit = PROJECT_ENTRY_LIMIT
): ReadonlyArray<ProjectEntry> => {
  const directories = new Set<string>()
  for (const file of files) {
    const segments = file.split('/')
    for (let depth = 1; depth < segments.length; depth++) {
      directories.add(segments.slice(0, depth).join('/'))
    }
  }
  const sorted = (paths: Iterable<string>) => [...paths].sort((a, b) => a.localeCompare(b))
  return [
    ...sorted(directories).map((path): ProjectEntry => ({ path, kind: 'directory' })),
    ...sorted(files).map((path): ProjectEntry => ({ path, kind: 'file' }))
  ].slice(0, limit)
}

/**
 * Lists the files and directories under a session's working directory for the `@` path menu.
 * `list(cwd)` reads a git repository through the `Git` that `dia-git` provides, so `.gitignore`
 * applies; any other directory, and every directory while `dia-git` is not loaded or is reloading,
 * is walked one directory at a time, skipping `.git`, `node_modules` and any entry it cannot read. It returns at most
 * {@link PROJECT_ENTRY_LIMIT} entries, and an empty list when `cwd` cannot be read. Each call
 * reads the directory again.
 */
export class ProjectEntries extends Context.Service<
  ProjectEntries,
  { readonly list: (cwd: string) => Effect.Effect<ReadonlyArray<ProjectEntry>> }
>()('ProjectEntries') {}

/** Builds the live {@link ProjectEntries}; requires `HostPlugins` and the file system and path services. */
export const ProjectEntriesLive = Layer.effect(
  ProjectEntries,
  Effect.gen(function* () {
    const plugins = yield* HostPlugins
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const gitFiles = (cwd: string) =>
      plugins
        .use(GitKey, (git) => git.listFiles(cwd))
        .pipe(Effect.map(Option.getOrElse((): ReadonlyArray<string> => [])))

    const entryAt = (cwd: string, relative: string) =>
      fs.stat(path.join(cwd, relative)).pipe(
        Effect.map(
          (info): ProjectEntry => ({
            path: relative,
            kind: info.type === 'Directory' ? 'directory' : 'file'
          })
        ),
        Effect.option
      )

    const walk = Effect.fn('ProjectEntries.walk')(function* (cwd: string) {
      const entries: Array<ProjectEntry> = []
      const pending = ['']
      while (pending.length > 0 && entries.length < PROJECT_ENTRY_LIMIT) {
        const directory = pending.shift() ?? ''
        const names = yield* fs
          .readDirectory(path.join(cwd, directory))
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        const children = names
          .filter((name) => !SKIPPED_SEGMENTS.has(name))
          .map((name) => (directory === '' ? name : `${directory}/${name}`))
        const read = yield* Effect.forEach(children, (child) => entryAt(cwd, child), {
          concurrency: 32
        })
        for (const entry of read) {
          if (Option.isNone(entry) || entries.length >= PROJECT_ENTRY_LIMIT) continue
          entries.push(entry.value)
          if (entry.value.kind === 'directory') pending.push(entry.value.path)
        }
      }
      return entries
    })

    const list = Effect.fn('ProjectEntries.list')(function* (cwd: string) {
      const entries = yield* gitFiles(cwd).pipe(
        Effect.flatMap((files) =>
          files.length > 0 ? Effect.succeed(entriesFromFiles(files)) : walk(cwd)
        ),
        Effect.catch((cause) =>
          Effect.logDebug('Walking a directory that git cannot list', { cwd, cause }).pipe(
            Effect.andThen(walk(cwd))
          )
        ),
        Effect.catch((cause) =>
          Effect.logWarning('Could not list the project entries', { cwd, cause }).pipe(
            Effect.as<ReadonlyArray<ProjectEntry>>([])
          )
        )
      )
      yield* Effect.logDebug('Listed the project entries', { cwd, count: entries.length })
      return entries
    })

    return { list }
  })
)
