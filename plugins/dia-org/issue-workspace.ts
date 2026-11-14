import {
  type GitOps,
  type PathsMoved,
  type ProjectId,
  relocatePath,
  type WorktreeInfo
} from '@dia/plugin'
import type { Issue, IssueId, Objective } from '@dia-plugin/dia-issues/domain'
import { Effect, Option, Schema } from 'effect'
import { SqlClient } from 'effect/sql'

/**
 * An issue's session runs in `path`: the project directory, or the issue's own worktree.
 * `projectDirectory` is the directory of the issue's project in either case.
 */
export const IssueDirectory = Schema.TaggedStruct('IssueDirectory', {
  path: Schema.String,
  projectDirectory: Schema.String
})

/** An issue cannot start yet; `reason` is the text to log. */
export const IssueWaiting = Schema.TaggedStruct('IssueWaiting', { reason: Schema.String })

/** Where a picked issue runs: {@link IssueDirectory}, or {@link IssueWaiting} until it can. */
export const IssueCwd = Schema.Union([IssueDirectory, IssueWaiting])
export type IssueCwd = typeof IssueCwd.Type

/**
 * Where org issues run, and the worktrees they hold. `open` returns the directory a picked
 * issue's session runs in, creating or reattaching its worktree when its project runs issues in
 * worktrees; it never fails. `retain` releases the worktree of every issue not in `issueIds`; call
 * it only while the org's issues are known.
 */
export interface IssueWorkspace {
  readonly open: (issue: Issue, objective: Objective) => Effect.Effect<IssueCwd>
  readonly retain: (issueIds: ReadonlySet<IssueId>) => Effect.Effect<void>
}

/** A project of the workspace as `makeIssueWorkspace` needs it. */
export interface WorkspaceProject {
  readonly directory: string
  readonly isGitRepo: boolean
}

interface IssueWorktreeRow {
  readonly issue_id: string
  readonly path: string
  readonly branch: string
  readonly source_repo: string
  readonly released: number
}

const infoOf = (row: IssueWorktreeRow): WorktreeInfo => ({
  path: row.path,
  branch: row.branch,
  sourceRepo: row.source_repo
})

const missingBranch = (cause: unknown) =>
  typeof cause === 'string' && /^Branch .* no longer exists$/.test(cause)

/**
 * Builds the {@link IssueWorkspace} over the org's `project_worktrees` and `issue_worktrees`
 * tables. `projectOf` reads a project of the followed workspace, `None` when it is absent; `gitOps`
 * reads the {@link GitOps} the `worktrees` plugin provides now, `None` while it is not provided.
 * It also returns `worktreeProjects`, the projects whose issues run in worktrees, and
 * `setWorktreeProjects`, the only writer of that set; a project's entry survives its removal from
 * the workspace and applies again when it returns.
 */
export const makeIssueWorkspace = (deps: {
  readonly projectOf: (projectId: ProjectId) => Effect.Effect<Option.Option<WorkspaceProject>>
  readonly gitOps: Effect.Effect<Option.Option<GitOps>>
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { projectOf, gitOps } = deps

    const worktreeProjects = sql<{
      readonly project_id: string
    }>`SELECT project_id FROM project_worktrees ORDER BY rowid`.pipe(
      Effect.map((rows) => rows.map((row) => row.project_id as ProjectId)),
      Effect.orDie
    )

    const setWorktreeProjects = Effect.fn('IssueWorkspace.setWorktreeProjects')(function* (
      projectId: ProjectId,
      enabled: boolean
    ) {
      yield* (
        enabled
          ? sql`INSERT OR IGNORE INTO project_worktrees ${sql.insert({ project_id: projectId })}`
          : sql`DELETE FROM project_worktrees WHERE project_id = ${projectId}`
      ).pipe(Effect.orDie)
      yield* Effect.logInfo('Set whether a project runs issues in worktrees', {
        projectId,
        enabled
      })
    })

    const rowOf = (issueId: IssueId) =>
      sql<IssueWorktreeRow>`SELECT * FROM issue_worktrees WHERE issue_id = ${issueId}`.pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.orDie
      )

    const store = (issueId: IssueId, info: WorktreeInfo) =>
      sql`INSERT OR REPLACE INTO issue_worktrees ${sql.insert({
        issue_id: issueId,
        path: info.path,
        branch: info.branch,
        source_repo: info.sourceRepo,
        released: 0
      })}`.pipe(Effect.orDie)

    const waiting = (issue: Issue, reason: string, detail: Record<string, unknown> = {}) =>
      Effect.logDebug('Issue cannot get a worktree yet', {
        issueId: issue.id,
        reason,
        ...detail
      }).pipe(Effect.as(IssueWaiting.make({ reason })))

    const create = Effect.fnUntraced(function* (git: GitOps, issue: Issue, directory: string) {
      const created = yield* Effect.result(
        git.createWorktree(
          directory,
          { paneId: issue.paneId, label: `Issue · ${issue.title}` },
          Option.some(`${issue.title.slice(0, 31)} ${issue.id.slice(0, 8)}`)
        )
      )
      if (created._tag === 'Failure') {
        return yield* waiting(issue, 'The worktree could not be created', {
          cause: created.failure.cause
        })
      }
      const info = created.success
      yield* store(issue.id, info)
      yield* Effect.logInfo('Created an issue worktree', { issueId: issue.id, path: info.path })
      const included = yield* Effect.result(git.findIncludedFiles(directory, issue.paneId))
      if (included._tag === 'Failure') {
        yield* Effect.logWarning('Could not read .worktreeinclude', {
          issueId: issue.id,
          cause: included.failure.cause
        })
      } else if (Option.isSome(included.success) && included.success.value.length > 0) {
        yield* git.copyIncludedFiles(info, included.success.value, issue.paneId)
      }
      return IssueDirectory.make({ path: info.path, projectDirectory: directory })
    })

    const reattach = Effect.fnUntraced(function* (
      git: GitOps,
      issue: Issue,
      directory: string,
      row: IssueWorktreeRow
    ) {
      const reattached = yield* Effect.result(git.reattachWorktree(infoOf(row), issue.paneId))
      if (reattached._tag === 'Success') {
        yield* sql`UPDATE issue_worktrees SET released = 0 WHERE issue_id = ${issue.id}`.pipe(
          Effect.orDie
        )
        return IssueDirectory.make({ path: reattached.success.path, projectDirectory: directory })
      }
      if (missingBranch(reattached.failure.cause)) {
        yield* Effect.logWarning('The branch of an issue worktree is gone; creating a new one', {
          issueId: issue.id,
          branch: row.branch
        })
        yield* sql`DELETE FROM issue_worktrees WHERE issue_id = ${issue.id}`.pipe(Effect.orDie)
        return yield* create(git, issue, directory)
      }
      return yield* waiting(issue, 'The worktree could not be reattached', {
        cause: reattached.failure.cause
      })
    })

    const open = Effect.fn('IssueWorkspace.open')(function* (issue: Issue, objective: Objective) {
      const project = yield* projectOf(objective.projectId)
      if (Option.isNone(project)) return yield* waiting(issue, 'The project is not registered')
      const { directory, isGitRepo } = project.value
      const enabled = (yield* worktreeProjects).includes(objective.projectId)
      if (!enabled || !isGitRepo)
        return IssueDirectory.make({ path: directory, projectDirectory: directory })
      const git = yield* gitOps
      if (Option.isNone(git)) return yield* waiting(issue, 'The worktrees plugin is not provided')
      const row = yield* rowOf(issue.id)
      return Option.isSome(row)
        ? yield* reattach(git.value, issue, directory, row.value)
        : yield* create(git.value, issue, directory)
    })

    const retain = Effect.fn('IssueWorkspace.retain')(function* (issueIds: ReadonlySet<IssueId>) {
      const rows =
        yield* sql<IssueWorktreeRow>`SELECT * FROM issue_worktrees WHERE released = 0`.pipe(
          Effect.orDie
        )
      const stale = rows.filter((row) => !issueIds.has(row.issue_id as IssueId))
      if (stale.length === 0) return
      const git = yield* gitOps
      if (Option.isNone(git)) return
      for (const row of stale) {
        const outcome = yield* git.value.releaseWorktree(infoOf(row), row.issue_id)
        yield* sql`UPDATE issue_worktrees SET released = 1 WHERE issue_id = ${row.issue_id}`.pipe(
          Effect.orDie
        )
        yield* Effect.logInfo('Released an issue worktree', {
          issueId: row.issue_id,
          path: row.path,
          outcome: outcome._tag
        })
      }
    })

    return { open, retain, worktreeProjects, setWorktreeProjects }
  })

/**
 * Rewrites every stored issue worktree path under `move.from` to its place under `move.to`. Pass
 * it to `ctx.onPathsMoved` before the issue workspace is used.
 */
export const moveIssueWorktrees = Effect.fn('IssueWorkspace.movePaths')(function* (
  move: PathsMoved
) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    readonly issue_id: string
    readonly path: string
  }>`SELECT issue_id, path FROM issue_worktrees`.pipe(Effect.orDie)
  let rewritten = 0
  for (const row of rows) {
    const path = relocatePath(row.path, move)
    if (Option.isNone(path)) continue
    yield* sql`UPDATE issue_worktrees SET path = ${path.value} WHERE issue_id = ${row.issue_id}`.pipe(
      Effect.orDie
    )
    rewritten += 1
  }
  yield* Effect.logInfo('Issue worktree paths moved', { ...move, rewritten })
})
