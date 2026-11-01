import type { MetaRepo } from '@dia/plugin'
import { Effect, FileSystem, Path } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

const INSTRUCTIONS_FILE = 'instructions.md'
const PLUGIN_DIRECTORY = 'plugin'

const PLUGIN_MANIFEST = `${JSON.stringify(
  {
    name: 'dia-meta',
    description: 'Skills, agents, hooks and commands that dia loads into every agent it starts.'
  },
  null,
  2
)}\n`

const GIT_STEPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['init'],
  ['add', '-A'],
  [
    '-c',
    'user.name=dia',
    '-c',
    'user.email=dia@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '-m',
    'chore: create the meta repo'
  ]
]

/**
 * Creates the meta repo (ADR-0025) in `directory` where it is missing: `instructions.md`, empty,
 * and `plugin/.claude-plugin/plugin.json`, a Claude Code plugin manifest. An existing file is
 * never overwritten. When `directory` is not yet a git repo it is initialised and the files are
 * committed. A failed git command is logged and skipped, so the files are usable without git.
 * Fails only when a file or directory cannot be created. Run it once in the plugin's setup with
 * the Node platform services provided.
 */
export const ensureMetaRepo = Effect.fn('MetaRepo.ensure')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const writeIfMissing = Effect.fnUntraced(function* (file: string, content: string) {
    if (yield* fs.exists(file)) return
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(file, content)
    yield* Effect.logInfo('Created a meta repo file', { file })
  })

  yield* writeIfMissing(path.join(directory, INSTRUCTIONS_FILE), '')
  yield* writeIfMissing(
    path.join(directory, PLUGIN_DIRECTORY, '.claude-plugin', 'plugin.json'),
    PLUGIN_MANIFEST
  )

  if (yield* fs.exists(path.join(directory, '.git'))) return
  for (const args of GIT_STEPS) {
    const exitCode = yield* spawner
      .exitCode(ChildProcess.make('git', [...args]).pipe(ChildProcess.setCwd(directory)))
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning('Could not run git in the meta repo', { args, error }).pipe(
            Effect.as(-1)
          )
        )
      )
    if (exitCode !== 0) {
      yield* Effect.logWarning('Stopped creating the meta repo history; a git command failed', {
        directory,
        args,
        exitCode
      })
      return
    }
  }
  yield* Effect.logInfo('Created the meta repo', { directory })
})

/**
 * The {@link MetaRepo} for the meta repo in `directory`, created with {@link ensureMetaRepo}.
 * Each run of `forNewSession` reads `instructions.md` again, trimmed, as the system-prompt append
 * (empty when it cannot be read) and offers `plugin/` as the one plugin path.
 */
export const makeMetaRepo = Effect.fn('MetaRepo.make')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const instructionsFile = path.join(directory, INSTRUCTIONS_FILE)
  const pluginPaths = [path.join(directory, PLUGIN_DIRECTORY)]

  const forNewSession = fs.readFileString(instructionsFile).pipe(
    Effect.map((text) => text.trim()),
    Effect.catch((error) =>
      Effect.logWarning('Could not read the meta repo instructions; appending nothing', {
        file: instructionsFile,
        error
      }).pipe(Effect.as(''))
    ),
    Effect.map((systemPromptAppend) => ({ systemPromptAppend, pluginPaths }))
  )
  return { forNewSession } satisfies MetaRepo
})
