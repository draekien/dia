import type { Git, MetaRepo } from '@dia/plugin'
import { Effect, FileSystem, Option, Path } from 'effect'
import { makeMetaPush } from './meta-push'

const INSTRUCTIONS_FILE = 'instructions.md'
const PLUGIN_DIRECTORY = 'plugin'

/** The name of the Claude Code plugin the meta repo holds; its skills are named `dia-meta:<skill>`. */
export const META_PLUGIN_NAME = 'dia-meta'

/** The local Claude Code plugin directory of the meta repo at `directory`; sessions load it as a plugin. */
export const metaPluginDirectory = (path: Path.Path, directory: string): string =>
  path.join(directory, PLUGIN_DIRECTORY)

/** The directory of the meta repo at `directory` that holds its plugin's skills. */
export const metaSkillsDirectory = (path: Path.Path, directory: string): string =>
  path.join(directory, PLUGIN_DIRECTORY, 'skills')

const PLUGIN_MANIFEST = `${JSON.stringify(
  {
    name: META_PLUGIN_NAME,
    description: 'Skills, agents, hooks and commands that dia loads into every agent it starts.'
  },
  null,
  2
)}\n`

const FIRST_COMMIT = {
  message: 'chore: create the meta repo',
  author: { name: 'dia', email: 'dia@localhost' }
}

/**
 * Creates the files of the meta repo (ADR-0025) in `directory` where they are missing:
 * `instructions.md`, empty, and `plugin/.claude-plugin/plugin.json`, a Claude Code plugin
 * manifest. An existing file is never overwritten. Needs no git. Fails only when a file or
 * directory cannot be created. Run it with the Node platform services provided.
 */
export const ensureMetaFiles = Effect.fn('MetaRepo.ensureFiles')(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

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
})

/**
 * Creates the meta repo (ADR-0025) in `directory`: its files, as {@link ensureMetaFiles} does,
 * and, when `directory` is not yet a git repo with a commit, a repository with the files
 * committed. A failed git command is logged and stops the history step, so the files are usable
 * without git. Fails only when a file or directory cannot be created. Run it with the Node
 * platform services provided.
 */
export const ensureMetaRepo = Effect.fn('MetaRepo.ensure')(function* (directory: string, git: Git) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* ensureMetaFiles(directory)

  const hasCommit =
    (yield* fs.exists(path.join(directory, '.git'))) &&
    Option.isSome(
      yield* git.resolveCommit(directory, 'HEAD').pipe(Effect.orElseSucceed(() => Option.none()))
    )
  if (hasCommit) return
  yield* git.init(directory).pipe(
    Effect.andThen(git.commitAll(directory, FIRST_COMMIT)),
    Effect.andThen(Effect.logInfo('Created the meta repo', { directory })),
    Effect.catch((error) =>
      Effect.logWarning('Stopped creating the meta repo history; a git command failed', {
        directory,
        args: error.args,
        exitCode: error.exitCode,
        stderr: error.stderr
      })
    )
  )
})

/**
 * The {@link MetaRepo} for the meta repo in `directory`, created with {@link ensureMetaRepo}.
 * Each run of `forNewSession` reads `instructions.md` again, trimmed, as the system-prompt append
 * (empty when it cannot be read) and offers `plugin/` as the one plugin path; it needs no git.
 * `state`, `setRemote` and `push` are those of {@link makeMetaPush}, run with the `Git`
 * `currentGit` gives at each call.
 */
export const makeMetaRepo = Effect.fn('MetaRepo.make')(function* (
  directory: string,
  currentGit: Effect.Effect<Option.Option<Git>>
) {
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
  const metaPush = yield* makeMetaPush(directory, currentGit)
  return { forNewSession, ...metaPush } satisfies MetaRepo
})
