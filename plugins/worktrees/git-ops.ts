import {
  type GitOps,
  type IncludedFileFailure,
  WorktreeCreateError,
  WorktreeIncludeError,
  WorktreeReattachError,
  WorktreeRemoveError
} from '@dia/plugin'
import type { PaneId, WorktreeInfo } from '@shared/domain/pane'
import {
  Data,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Random,
  Result,
  Schedule
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { generateWorktreeSlug } from './worktree-slug'

const PORCELAIN_WORKTREE_PREFIX = 'worktree '

const INCLUDE_FILE = '.worktreeinclude'

const COPY_CONCURRENCY = 8

const LEFTOVER_REMOVE_SCHEDULE = Schedule.spaced(Duration.millis(250)).pipe(
  Schedule.upTo({ duration: Duration.seconds(3) })
)

class DirectoryNotEmpty extends Data.TaggedError('DirectoryNotEmpty') {}

const isNotFound = (error: PlatformError.PlatformError | DirectoryNotEmpty): boolean =>
  error._tag === 'PlatformError' && error.reason._tag === 'NotFound'

const isRetryable = (error: PlatformError.PlatformError | DirectoryNotEmpty): boolean =>
  error._tag === 'PlatformError' && !isNotFound(error)

const copyFailureReason = (error: PlatformError.PlatformError): string => {
  const cause = error.reason.cause
  if (Predicate.hasProperty(cause, 'message') && Predicate.isString(cause.message)) {
    return cause.message.split(', ')[0] ?? cause.message
  }
  return error.message
}

/**
 * Builds the {@link GitOps} the `worktrees` plugin provides, shelling out to the `git` CLI through
 * the platform `ChildProcessSpawner`. Run it once in the plugin's setup with the Node platform
 * services provided.
 */
export const makeGitOps = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const branchExists = Effect.fn('GitOps.branchExists')(function* (
    sourceRepo: string,
    paneId: PaneId,
    branch: string
  ) {
    const command = ChildProcess.make('git', [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`
    ]).pipe(ChildProcess.setCwd(sourceRepo))
    const exitCode = yield* spawner
      .exitCode(command)
      .pipe(Effect.mapError((cause) => new WorktreeCreateError({ paneId, sourceRepo, cause })))
    return exitCode === 0
  })

  // A worktree's directory is removed on graceful shutdown but its branch persists (and
  // lingers after a pane is closed), so a fresh pane can generate a name whose branch already
  // exists even though no directory does -- both must be checked. After a bounded number of
  // clashes (astronomically unlikely) fall back to appending random hex to force a unique name.
  const MAX_SLUG_ATTEMPTS = 50
  const findAvailableWorktreeName = Effect.fn('GitOps.findAvailableWorktreeName')(function* (
    sourceRepo: string,
    paneId: PaneId,
    worktreesRoot: string
  ) {
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = yield* generateWorktreeSlug()
      const branch = `dia/${slug}`
      const dirPath = path.join(worktreesRoot, slug)
      const dirTaken = yield* fs.exists(dirPath).pipe(Effect.orElseSucceed(() => false))
      const taken = dirTaken || (yield* branchExists(sourceRepo, paneId, branch))
      if (!taken) return { path: dirPath, branch }
    }

    const base = yield* generateWorktreeSlug()
    const suffix = (yield* Random.nextIntBetween(0x1000, 0x10000)).toString(16)
    const slug = `${base}-${suffix}`
    return { path: path.join(worktreesRoot, slug), branch: `dia/${slug}` }
  })

  const createWorktree = Effect.fn('GitOps.createWorktree')(function* (
    sourceRepo: string,
    paneId: PaneId,
    worktreesRoot: string
  ) {
    const { path: worktreePath, branch } = yield* findAvailableWorktreeName(
      sourceRepo,
      paneId,
      worktreesRoot
    )
    const command = ChildProcess.make('git', ['worktree', 'add', worktreePath, '-b', branch]).pipe(
      ChildProcess.setCwd(sourceRepo)
    )
    const exitCode = yield* spawner
      .exitCode(command)
      .pipe(Effect.mapError((cause) => new WorktreeCreateError({ paneId, sourceRepo, cause })))

    if (exitCode !== 0) {
      return yield* new WorktreeCreateError({
        paneId,
        sourceRepo,
        cause: `git worktree add exited with code ${exitCode}`
      })
    }

    yield* Effect.logInfo('Created pane worktree', { paneId, path: worktreePath, branch })
    return { path: worktreePath, branch, sourceRepo }
  })

  const removeIfEmpty = (directory: string) =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(directory)
      if (entries.length > 0) return yield* new DirectoryNotEmpty()
      yield* fs.remove(directory, { recursive: true })
    })

  const removeLeftoverDirectory = Effect.fn('GitOps.removeLeftoverDirectory')(function* (
    directory: string,
    paneId: PaneId
  ) {
    const outcome = yield* removeIfEmpty(directory).pipe(
      Effect.retry({ schedule: LEFTOVER_REMOVE_SCHEDULE, while: isRetryable }),
      Effect.result
    )
    if (Result.isSuccess(outcome)) {
      yield* Effect.logInfo('Removed the empty worktree directory', { paneId, path: directory })
    } else if (outcome.failure._tag === 'DirectoryNotEmpty') {
      yield* Effect.logWarning('Left a worktree directory that is not empty on disk', {
        paneId,
        path: directory
      })
    } else if (!isNotFound(outcome.failure)) {
      yield* Effect.logWarning('Could not remove the empty worktree directory', {
        paneId,
        path: directory,
        cause: outcome.failure
      })
    }
  })

  const removeWorktree = Effect.fn('GitOps.removeWorktree')(function* (
    info: WorktreeInfo,
    paneId: PaneId
  ) {
    const command = ChildProcess.make('git', ['worktree', 'remove', '--force', info.path]).pipe(
      ChildProcess.setCwd(info.sourceRepo)
    )
    const exitCode = yield* spawner
      .exitCode(command)
      .pipe(Effect.mapError((cause) => new WorktreeRemoveError({ paneId, path: info.path, cause })))

    if (exitCode === 0) {
      yield* Effect.logInfo('Removed pane worktree', { paneId, path: info.path })
      return
    }

    yield* Effect.logWarning('Standard worktree remove failed, trying with --prune', {
      paneId,
      path: info.path,
      exitCode
    })
    const pruneCommand = ChildProcess.make('git', ['worktree', 'prune']).pipe(
      ChildProcess.setCwd(info.sourceRepo)
    )
    const pruneExitCode = yield* spawner
      .exitCode(pruneCommand)
      .pipe(Effect.mapError((cause) => new WorktreeRemoveError({ paneId, path: info.path, cause })))

    if (pruneExitCode !== 0) {
      // Log the error but don't fail — the worktree directory can be cleaned up later.
      // This ensures pane teardown doesn't block on git worktree removal failures.
      yield* Effect.logWarning('Failed to prune worktree; manual cleanup may be needed', {
        paneId,
        path: info.path,
        pruneExitCode
      })
      return
    }

    yield* Effect.logInfo('Pruned pane worktree', { paneId, path: info.path })
    yield* removeLeftoverDirectory(info.path, paneId)
  })

  const comparablePath = (value: string): string => {
    const forward = value.replaceAll('\\', '/').replace(/\/+$/, '')
    return /^[a-zA-Z]:/.test(forward) ? forward.toLowerCase() : forward
  }

  const isRegisteredWorktree = Effect.fn('GitOps.isRegisteredWorktree')(function* (
    info: WorktreeInfo,
    paneId: PaneId
  ) {
    const output = yield* spawner
      .string(
        ChildProcess.make('git', ['worktree', 'list', '--porcelain']).pipe(
          ChildProcess.setCwd(info.sourceRepo)
        )
      )
      .pipe(
        Effect.mapError((cause) => new WorktreeReattachError({ paneId, path: info.path, cause }))
      )
    const target = comparablePath(info.path)
    return output
      .split(/\r?\n/)
      .some(
        (line) =>
          line.startsWith(PORCELAIN_WORKTREE_PREFIX) &&
          comparablePath(line.slice(PORCELAIN_WORKTREE_PREFIX.length)) === target
      )
  })

  const reattachWorktree = Effect.fn('GitOps.reattachWorktree')(function* (
    info: WorktreeInfo,
    paneId: PaneId
  ) {
    const pathExists = yield* fs.exists(info.path).pipe(Effect.orElseSucceed(() => false))
    if (pathExists) {
      if (yield* isRegisteredWorktree(info, paneId)) {
        yield* Effect.logWarning(
          'Worktree path is already a registered worktree; skipping reattach',
          {
            paneId,
            path: info.path
          }
        )
        return info
      }

      const entries = yield* fs
        .readDirectory(info.path)
        .pipe(
          Effect.mapError((cause) => new WorktreeReattachError({ paneId, path: info.path, cause }))
        )
      if (entries.length > 0) {
        return yield* new WorktreeReattachError({
          paneId,
          path: info.path,
          cause: 'path exists, is not a registered worktree, and is not empty'
        })
      }
      yield* Effect.logWarning('Reusing an empty unregistered worktree directory', {
        paneId,
        path: info.path
      })
    }

    const command = ChildProcess.make('git', ['worktree', 'add', info.path, info.branch]).pipe(
      ChildProcess.setCwd(info.sourceRepo)
    )
    const exitCode = yield* spawner
      .exitCode(command)
      .pipe(
        Effect.mapError((cause) => new WorktreeReattachError({ paneId, path: info.path, cause }))
      )

    if (exitCode !== 0) {
      return yield* new WorktreeReattachError({
        paneId,
        path: info.path,
        cause: `git worktree add exited with code ${exitCode}`
      })
    }

    yield* Effect.logInfo('Reattached pane worktree', {
      paneId,
      path: info.path,
      branch: info.branch
    })
    return info
  })

  const findIncludedFiles = Effect.fn('GitOps.findIncludedFiles')(function* (
    sourceRepo: string,
    paneId: PaneId
  ) {
    const includeFile = path.join(sourceRepo, INCLUDE_FILE)
    if (!(yield* fs.exists(includeFile).pipe(Effect.orElseSucceed(() => false)))) {
      yield* Effect.logDebug('No .worktreeinclude in the project', { paneId, sourceRepo })
      return Option.none<ReadonlyArray<string>>()
    }
    const command = ChildProcess.make('git', [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      `--exclude-from=${includeFile}`
    ]).pipe(
      ChildProcess.pipeTo(ChildProcess.make('git', ['check-ignore', '-z', '--stdin'])),
      ChildProcess.setCwd(sourceRepo)
    )
    const output = yield* spawner
      .string(command)
      .pipe(Effect.mapError((cause) => new WorktreeIncludeError({ paneId, sourceRepo, cause })))
    const files = output.split('\0').filter((file) => file !== '')
    yield* Effect.logInfo('Matched .worktreeinclude files', { paneId, count: files.length })
    return Option.some<ReadonlyArray<string>>(files)
  })

  const copyIncludedFile = Effect.fnUntraced(function* (worktree: WorktreeInfo, file: string) {
    const destination = path.join(worktree.path, file)
    if (yield* fs.exists(destination)) return 'skipped' as const
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true })
    yield* fs.copyFile(path.join(worktree.sourceRepo, file), destination)
    return 'copied' as const
  })

  const copyIncludedFiles = Effect.fn('GitOps.copyIncludedFiles')(function* (
    worktree: WorktreeInfo,
    files: ReadonlyArray<string>,
    paneId: PaneId
  ) {
    const outcomes = yield* Effect.forEach(
      files,
      (file) =>
        copyIncludedFile(worktree, file).pipe(
          Effect.catch((error) =>
            Effect.succeed<IncludedFileFailure>({ path: file, reason: copyFailureReason(error) })
          )
        ),
      { concurrency: COPY_CONCURRENCY }
    )
    const failures: Array<IncludedFileFailure> = []
    let skipped = 0
    for (const outcome of outcomes) {
      if (outcome === 'skipped') skipped++
      else if (outcome !== 'copied') failures.push(outcome)
    }
    yield* Effect.logInfo('Copied .worktreeinclude files', {
      paneId,
      path: worktree.path,
      matched: files.length,
      skipped,
      failed: failures.length
    })
    if (failures.length > 0) {
      yield* Effect.logWarning('Some .worktreeinclude files were not copied', { paneId, failures })
    }
    return failures
  })

  const gitOps: GitOps = {
    createWorktree,
    removeWorktree,
    reattachWorktree,
    findIncludedFiles,
    copyIncludedFiles
  }
  return gitOps
})
