import {
  type Git,
  type GitOps,
  type IncludedFileFailure,
  type ReleaseOutcome,
  WorktreeCreateError,
  WorktreeIncludeError,
  WorktreeKept,
  WorktreeReattachError,
  WorktreeReleased
} from '@dia/plugin'
import type { PaneId, WorktreeInfo, WorktreeOwner } from '@shared/domain/pane'
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
import { generateWorktreeSlug } from './worktree-slug'

const INCLUDE_FILE = '.worktreeinclude'

const COPY_CONCURRENCY = 8

const MAX_SLUG_ATTEMPTS = 50

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

const MAX_SLUG_LENGTH = 40

/**
 * Reduces free text to a branch- and directory-safe name: lowercase letters, digits and single
 * hyphens, at most 40 characters, with no leading or trailing hyphen. Returns an empty string when
 * `text` holds no letter or digit, so callers must fall back to a generated name.
 */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '')

/**
 * The {@link GitOps} operations the `worktrees` plugin runs against git, plus `forceRemoveWorktree`
 * for the user's Discard: it removes the directory even when it holds modified or untracked files,
 * never deletes the branch, and does not fail.
 */
export interface GitCommands extends GitOps {
  readonly forceRemoveWorktree: (info: WorktreeInfo, paneId: PaneId) => Effect.Effect<void>
}

/**
 * Builds the {@link GitCommands} the `worktrees` plugin runs through `git`, the `dia-git` service.
 * New worktrees are created under `worktreesRoot`. Run it with the Node file system and path
 * services provided.
 */
export const makeGitOps = (worktreesRoot: string, git: Git) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const branchExists = Effect.fn('GitOps.branchExists')(function* (
      sourceRepo: string,
      paneId: PaneId,
      branch: string
    ) {
      return yield* git
        .branchExists(sourceRepo, branch)
        .pipe(Effect.mapError((cause) => new WorktreeCreateError({ paneId, sourceRepo, cause })))
    })

    // A worktree's directory is removed on graceful shutdown but its branch persists (and
    // lingers after a pane is closed), so a fresh pane can generate a name whose branch already
    // exists even though no directory does -- both must be checked. After a bounded number of
    // clashes (astronomically unlikely) fall back to appending random hex to force a unique name.
    const findAvailableWorktreeName = Effect.fn('GitOps.findAvailableWorktreeName')(function* (
      sourceRepo: string,
      paneId: PaneId,
      nameHint: Option.Option<string>
    ) {
      const hinted = nameHint.pipe(
        Option.map(slugify),
        Option.filter((slug) => slug !== '')
      )
      const candidate = (slug: string) => ({
        path: path.join(worktreesRoot, slug),
        branch: `dia/${slug}`
      })
      const isFree = Effect.fnUntraced(function* (slug: string) {
        const { path: dirPath, branch } = candidate(slug)
        const dirTaken = yield* fs.exists(dirPath).pipe(Effect.orElseSucceed(() => false))
        return !dirTaken && !(yield* branchExists(sourceRepo, paneId, branch))
      })
      const nextBase = Option.isSome(hinted) ? Effect.succeed(hinted.value) : generateWorktreeSlug()
      const randomSuffix = Effect.map(Random.nextIntBetween(0x1000, 0x10000), (n) => n.toString(16))

      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
        const base = yield* nextBase
        const slug = Option.isSome(hinted) && attempt > 0 ? `${base}-${yield* randomSuffix}` : base
        if (yield* isFree(slug)) return candidate(slug)
      }
      return candidate(`${yield* nextBase}-${yield* randomSuffix}`)
    })

    const createWorktree = Effect.fn('GitOps.createWorktree')(function* (
      sourceRepo: string,
      owner: WorktreeOwner,
      nameHint: Option.Option<string>
    ) {
      const paneId = owner.paneId
      const { path: worktreePath, branch } = yield* findAvailableWorktreeName(
        sourceRepo,
        paneId,
        nameHint
      )
      yield* git.addWorktree(sourceRepo, worktreePath, branch, { createBranch: true }).pipe(
        Effect.mapError(
          (error) =>
            new WorktreeCreateError({
              paneId,
              sourceRepo,
              cause: `git worktree add exited with code ${error.exitCode}`
            })
        )
      )

      yield* Effect.logInfo('Created worktree', { paneId, path: worktreePath, branch })
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

    const pruneAndRemoveLeftover = Effect.fn('GitOps.pruneAndRemoveLeftover')(function* (
      info: WorktreeInfo,
      paneId: PaneId
    ) {
      const pruned = yield* git.pruneWorktrees(info.sourceRepo).pipe(Effect.result)
      if (Result.isFailure(pruned)) {
        yield* Effect.logWarning('Failed to prune worktree; manual cleanup may be needed', {
          paneId,
          path: info.path,
          pruneExitCode: pruned.failure.exitCode
        })
        return
      }

      yield* Effect.logInfo('Pruned worktree', { paneId, path: info.path })
      yield* removeLeftoverDirectory(info.path, paneId)
    })

    const removeCommand = (info: WorktreeInfo, force: boolean) =>
      git.removeWorktree(info.sourceRepo, info.path, { force }).pipe(
        Effect.as(0),
        Effect.catch((error) => Effect.succeed(error.exitCode))
      )

    const countChangedFiles = (info: WorktreeInfo) =>
      git.status(info.path).pipe(
        Effect.map((entries) => entries.length),
        Effect.orElseSucceed(() => 0)
      )

    const releaseWorktree = Effect.fn('GitOps.releaseWorktree')(function* (
      info: WorktreeInfo,
      paneId: PaneId
    ): Effect.fn.Return<ReleaseOutcome> {
      const exitCode = yield* removeCommand(info, false)
      if (exitCode === 0) {
        yield* Effect.logInfo('Removed worktree', { paneId, path: info.path })
        return WorktreeReleased.make({})
      }

      const changedFiles = yield* countChangedFiles(info)
      if (changedFiles > 0) {
        yield* Effect.logInfo('Kept a worktree with modified or untracked files', {
          paneId,
          path: info.path,
          changedFiles
        })
        return WorktreeKept.make({ changedFiles })
      }

      yield* Effect.logWarning('Standard worktree remove failed, trying with --prune', {
        paneId,
        path: info.path,
        exitCode
      })
      yield* pruneAndRemoveLeftover(info, paneId)
      return WorktreeReleased.make({})
    })

    const forceRemoveWorktree = Effect.fn('GitOps.forceRemoveWorktree')(function* (
      info: WorktreeInfo,
      paneId: PaneId
    ) {
      const exitCode = yield* removeCommand(info, true)
      if (exitCode === 0) {
        yield* Effect.logInfo('Force-removed worktree', { paneId, path: info.path })
        return
      }
      yield* Effect.logWarning('Forced worktree remove failed, trying with --prune', {
        paneId,
        path: info.path,
        exitCode
      })
      yield* pruneAndRemoveLeftover(info, paneId)
    })

    const comparablePath = (value: string): string => {
      const forward = value.replaceAll('\\', '/').replace(/\/+$/, '')
      return /^[a-zA-Z]:/.test(forward) ? forward.toLowerCase() : forward
    }

    const isRegisteredWorktree = Effect.fn('GitOps.isRegisteredWorktree')(function* (
      info: WorktreeInfo,
      paneId: PaneId
    ) {
      const worktrees = yield* git
        .listWorktrees(info.sourceRepo)
        .pipe(
          Effect.mapError((cause) => new WorktreeReattachError({ paneId, path: info.path, cause }))
        )
      const target = comparablePath(info.path)
      return worktrees.some((worktree) => comparablePath(worktree) === target)
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
            Effect.mapError(
              (cause) => new WorktreeReattachError({ paneId, path: info.path, cause })
            )
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

      const verified = yield* git.branchExists(info.sourceRepo, info.branch).pipe(Effect.result)
      if (Result.isFailure(verified) || !verified.success) {
        yield* Effect.logWarning('Did not reattach a worktree whose branch could not be verified', {
          paneId,
          branch: info.branch,
          exitCode: Result.isFailure(verified) ? verified.failure.exitCode : 1
        })
        return yield* new WorktreeReattachError({
          paneId,
          path: info.path,
          cause: Result.isFailure(verified)
            ? `git rev-parse exited with code ${verified.failure.exitCode}`
            : `Branch ${info.branch} no longer exists`
        })
      }

      yield* git.addWorktree(info.sourceRepo, info.path, info.branch, { createBranch: false }).pipe(
        Effect.mapError(
          (error) =>
            new WorktreeReattachError({
              paneId,
              path: info.path,
              cause: `git worktree add exited with code ${error.exitCode}`
            })
        )
      )

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
      const files = yield* git
        .ignoredMatching(sourceRepo, includeFile)
        .pipe(Effect.mapError((cause) => new WorktreeIncludeError({ paneId, sourceRepo, cause })))
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
        yield* Effect.logWarning('Some .worktreeinclude files were not copied', {
          paneId,
          failures
        })
      }
      return failures
    })

    const gitOps: GitCommands = {
      createWorktree,
      releaseWorktree,
      forceRemoveWorktree,
      reattachWorktree,
      findIncludedFiles,
      copyIncludedFiles
    }
    return gitOps
  })
