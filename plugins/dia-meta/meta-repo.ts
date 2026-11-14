import type { Git, GitError, GitStatusEntry, MetaRepo } from '@dia/plugin'
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

const SKILL_FILE = 'SKILL.md'
const REFERENCE_FILE = 'references/api.md'
const SKILL_DIRECTORY = `${PLUGIN_DIRECTORY}/skills/building-dia-plugins`
const SKILL_PATH = `${SKILL_DIRECTORY}/${SKILL_FILE}`
const REFERENCE_PATH = `${SKILL_DIRECTORY}/${REFERENCE_FILE}`

const AUTHOR = { name: 'dia', email: 'dia@localhost' }

const FIRST_COMMIT = { message: 'chore: create the meta repo', author: AUTHOR }

const SKILL_COMMIT = {
  message: 'docs: update the built-in building-dia-plugins skill',
  author: AUTHOR
}

/**
 * Creates the files of the meta repo (ADR-0025) in `directory` where they are missing:
 * `instructions.md`, empty, `plugin/.claude-plugin/plugin.json`, a Claude Code plugin manifest,
 * and the `building-dia-plugins` skill's `SKILL.md`, copied from `skillSource`, the folder dia
 * ships the skill in. An existing file is never overwritten, except the skill's
 * `references/api.md`, which is rewritten whenever its content, ignoring line endings, differs
 * from the copy in `skillSource`. A file missing from `skillSource` is logged and skipped. Needs no
 * git. Fails only when a file or directory cannot be created. Run it with the Node platform
 * services provided.
 */
export const ensureMetaFiles = Effect.fn('MetaRepo.ensureFiles')(function* (
  directory: string,
  skillSource: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const writeIfMissing = Effect.fnUntraced(function* (
    file: string,
    content: Effect.Effect<string | undefined>
  ) {
    if (yield* fs.exists(file)) return
    const text = yield* content
    if (text === undefined) return
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(file, text)
    yield* Effect.logInfo('Created a meta repo file', { file })
  })

  const readShipped = (file: string) =>
    fs.readFileString(path.join(skillSource, file)).pipe(
      Effect.tapError((error) =>
        Effect.logWarning('dia shipped no copy of a built-in skill file; skipping it', {
          file,
          error
        })
      ),
      Effect.orElseSucceed(() => undefined)
    )

  yield* writeIfMissing(path.join(directory, INSTRUCTIONS_FILE), Effect.succeed(''))
  yield* writeIfMissing(
    path.join(directory, PLUGIN_DIRECTORY, '.claude-plugin', 'plugin.json'),
    Effect.succeed(PLUGIN_MANIFEST)
  )
  yield* writeIfMissing(path.join(directory, SKILL_PATH), readShipped(SKILL_FILE))

  const referenceFile = path.join(directory, REFERENCE_PATH)
  const shippedReference = yield* readShipped(REFERENCE_FILE)
  const currentReference = yield* fs.readFileString(referenceFile).pipe(
    Effect.map((text) => text.replaceAll('\r\n', '\n')),
    Effect.orElseSucceed(() => undefined)
  )
  if (shippedReference === undefined || shippedReference === currentReference) return
  yield* fs.makeDirectory(path.dirname(referenceFile), { recursive: true })
  yield* fs.writeFileString(referenceFile, shippedReference)
  yield* Effect.logInfo('Wrote the dia plugin API reference', { file: referenceFile })
})

const skillPathsToCommit = (entries: ReadonlyArray<GitStatusEntry>): ReadonlyArray<string> => {
  const untracked = (file: string) =>
    entries.some(
      (entry) =>
        entry.code === '??' &&
        (entry.path === file || (entry.path.endsWith('/') && file.startsWith(entry.path)))
    )
  const changed = (file: string) => untracked(file) || entries.some((entry) => entry.path === file)
  return [SKILL_PATH].filter(untracked).concat([REFERENCE_PATH].filter(changed))
}

/**
 * Creates the meta repo (ADR-0025) in `directory`: its files, as {@link ensureMetaFiles} does
 * with `skillSource`, and, when `directory` is not yet a git repo with a commit, a repository with
 * the files committed. In a repository that has a commit it commits, on their own, the skill's
 * `SKILL.md` when git does not track it yet and the skill's `references/api.md` when it differs
 * from the committed one; other changes in the repository stay out of that commit. A failed git
 * command is logged and stops the history step, so the files are usable without git. Fails only
 * when a file or directory cannot be created. Run it with the Node platform services provided.
 */
export const ensureMetaRepo = Effect.fn('MetaRepo.ensure')(function* (
  directory: string,
  skillSource: string,
  git: Git
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* ensureMetaFiles(directory, skillSource)

  const logGitFailure = (step: string) => (error: GitError) =>
    Effect.logWarning(`Stopped ${step}; a git command failed`, {
      directory,
      args: error.args,
      exitCode: error.exitCode,
      stderr: error.stderr
    })

  const hasCommit =
    (yield* fs.exists(path.join(directory, '.git'))) &&
    Option.isSome(
      yield* git.resolveCommit(directory, 'HEAD').pipe(Effect.orElseSucceed(() => Option.none()))
    )
  if (!hasCommit) {
    yield* git
      .init(directory)
      .pipe(
        Effect.andThen(git.commitAll(directory, FIRST_COMMIT)),
        Effect.andThen(Effect.logInfo('Created the meta repo', { directory })),
        Effect.catch(logGitFailure('creating the meta repo history'))
      )
    return
  }
  yield* git.status(directory).pipe(
    Effect.map(skillPathsToCommit),
    Effect.tap((paths) =>
      paths.length === 0
        ? Effect.void
        : git
            .commitPaths(directory, paths, SKILL_COMMIT)
            .pipe(
              Effect.andThen(
                Effect.logInfo('Committed the built-in building-dia-plugins skill', { paths })
              )
            )
    ),
    Effect.catch(logGitFailure('committing the built-in building-dia-plugins skill'))
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
