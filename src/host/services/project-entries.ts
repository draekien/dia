import type { ProjectEntry } from '@shared/domain/attachment'
import { Context, Effect, FileSystem, Layer, Path } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

/** The most entries {@link ProjectEntries.list} returns for one directory. */
export const PROJECT_ENTRY_LIMIT = 20_000

const SKIPPED_SEGMENTS = new Set(['.git', 'node_modules'])

/**
 * The entries for `files`, the `/`-separated relative paths `git ls-files` prints: every
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
 * `list(cwd)` reads a git repository through `git ls-files`, so `.gitignore` applies; any other
 * directory is walked, skipping `.git` and `node_modules`. It returns at most
 * {@link PROJECT_ENTRY_LIMIT} entries, and an empty list when `cwd` cannot be read. Each call
 * reads the directory again.
 */
export class ProjectEntries extends Context.Service<
  ProjectEntries,
  { readonly list: (cwd: string) => Effect.Effect<ReadonlyArray<ProjectEntry>> }
>()('ProjectEntries') {}

/** Builds the live {@link ProjectEntries}; requires the platform spawner, file system and path services. */
export const ProjectEntriesLive = Layer.effect(
  ProjectEntries,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const gitFiles = (cwd: string) =>
      spawner
        .string(
          ChildProcess.make('git', [
            'ls-files',
            '-z',
            '--cached',
            '--others',
            '--exclude-standard'
          ]).pipe(ChildProcess.setCwd(cwd))
        )
        .pipe(Effect.map((output) => output.split('\0').filter((line) => line !== '')))

    const walk = Effect.fn('ProjectEntries.walk')(function* (cwd: string) {
      const relative = yield* fs.readDirectory(cwd, { recursive: true })
      const kept = relative
        .map((entry) => entry.split(path.sep).join('/'))
        .filter((entry) => !entry.split('/').some((segment) => SKIPPED_SEGMENTS.has(segment)))
        .slice(0, PROJECT_ENTRY_LIMIT)
      return yield* Effect.forEach(
        kept,
        (entry) =>
          fs.stat(path.join(cwd, entry)).pipe(
            Effect.map(
              (info): ProjectEntry => ({
                path: entry,
                kind: info.type === 'Directory' ? 'directory' : 'file'
              })
            )
          ),
        { concurrency: 32 }
      )
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
