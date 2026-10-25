import type { Project, ProjectId } from '@shared/domain/project'
import { Effect, FileSystem, Path } from 'effect'

/**
 * The key two spellings of one directory share, for refusing a second registration of it: the
 * resolved absolute path, without a trailing separator, lower-cased where paths use `\` (Windows,
 * whose file system ignores case). Compute it in the Host; store it as `Project.directoryKey`.
 */
export const directoryKey = Effect.fnUntraced(function* (directory: string) {
  const path = yield* Path.Path
  const resolved = path.resolve(directory)
  return path.sep === '\\' ? resolved.toLowerCase() : resolved
})

/**
 * The {@link Project} for `directory` as it is on disk now: its key, its base name as display
 * name, and whether it is a git repo or worktree (it has a `.git` entry). A directory that does
 * not exist gives `isGitRepo: false`; check existence first where that must be refused.
 */
export const probeProject = Effect.fn('probeProject')(function* (
  projectId: ProjectId,
  directory: string
) {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const isGitRepo = yield* fs
    .exists(path.join(directory, '.git'))
    .pipe(Effect.orElseSucceed(() => false))
  const project: Project = {
    projectId,
    directory,
    directoryKey: yield* directoryKey(directory),
    displayName: path.basename(path.resolve(directory)),
    isGitRepo
  }
  yield* Effect.logDebug('Probed project directory', { directory, isGitRepo })
  return project
})
