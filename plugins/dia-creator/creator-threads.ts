import {
  AgentName,
  type Git,
  type GitOps,
  type PluginControl,
  type RunEvents,
  type Runs
} from '@dia/plugin'
import type { AgentDefinitionRegistry } from '@dia-plugin/dia-agent-definitions/registry'
import { type RunChoices, runSettings } from '@dia-plugin/dia-agent-definitions/run-settings'
import { Effect, Option } from 'effect'
import { CreatorUnavailable } from './calls'
import { CREATOR_DEFINITION, CREATOR_LABEL } from './creator-definition'
import { relativeInside } from './plugin-folders'
import type { TurnChanges } from './turn-changes'

/** The name of a new Creator thread's tab; the user renames it from the row's menu. */
export const CREATOR_TAB_NAME = AgentName.make('Creator')

/**
 * What Creator threads are started with: the runs they open, the run event log, git, the meta
 * repo's working tree `metaDirectory`, the definitions and model choices their options come from,
 * `gitOps` to reattach their worktrees, the plugins the Host knows, the turn changes that track
 * them, and `newRunId`, which returns a new run id.
 */
export interface CreatorThreadsDeps {
  readonly runs: Pick<Runs, 'open' | 'retire' | 'openInTab' | 'send' | 'list'>
  readonly runEvents: Pick<RunEvents, 'highestSequence'>
  readonly git: Pick<Git, 'resolveCommit'>
  readonly metaDirectory: string
  readonly definitions: Pick<AgentDefinitionRegistry, 'list'>
  readonly choices: RunChoices
  readonly gitOps: Pick<GitOps, 'reattachWorktree'>
  readonly plugins: PluginControl
  readonly turnChanges: Pick<TurnChanges, 'track' | 'unmerged'>
  readonly newRunId: Effect.Effect<string>
}

/** Starting Creator threads, and keeping unmerged threads' worktrees on disk across restarts. */
export interface CreatorThreads {
  /**
   * Starts a Creator run in a new worktree of the meta repo, tracks it, shows it in a tab under
   * Meta without selecting it, sends it `text`, and returns its run id.
   */
  readonly start: (text: string) => Effect.Effect<string, CreatorUnavailable>
  /**
   * Re-adds the worktree of every Creator thread that still has a run row and has unmerged
   * commits, and reloads each failed
   * plugin overridden to a folder inside one of them. Call it once the services are provided.
   */
  readonly reattachUnmerged: Effect.Effect<void>
}

const unavailable = (reason: CreatorUnavailable['reason'], message: string) =>
  Effect.andThen(
    Effect.logWarning('A Creator thread could not start', { reason, message }),
    Effect.fail(new CreatorUnavailable({ reason, message }))
  )

/** Builds {@link CreatorThreads} over `deps`. */
export const makeCreatorThreads = (deps: CreatorThreadsDeps): CreatorThreads => {
  const { runs, metaDirectory } = deps

  const creatorDefinition = Effect.map(deps.definitions.list, (listed) =>
    Option.fromNullishOr(
      listed.find((entry) => entry.definition.id === CREATOR_DEFINITION.id)?.definition
    )
  )

  const start = Effect.fn('CreatorThreads.start')(function* (text: string) {
    const head = yield* deps.git
      .resolveCommit(metaDirectory, 'HEAD')
      .pipe(Effect.orElseSucceed(() => Option.none<string>()))
    if (Option.isNone(head))
      return yield* unavailable('no-meta-repo', 'The meta repo is not available.')
    const definition = yield* creatorDefinition
    if (Option.isNone(definition)) {
      return yield* unavailable('definition-missing', 'The Creator agent definition is missing.')
    }
    const settings = yield* runSettings(
      deps.choices,
      definition.value,
      metaDirectory,
      definition.value.bypassOptIn
    )
    if (Option.isNone(settings))
      return yield* unavailable('no-model', 'No agent adapter is loaded.')
    const runId = yield* deps.newRunId
    const config = yield* runs
      .open({
        runId,
        sourceCwd: metaDirectory,
        ...settings.value,
        worktree: { _tag: 'Create', label: 'Creator' },
        resume: Option.none(),
        labels: [CREATOR_LABEL],
        systemPromptAppend: definition.value.jobDescription,
        permissions: definition.value.permissions
      })
      .pipe(
        Effect.catchTag(['WorktreeCreateError', 'WorktreeReattachError'], (error) =>
          unavailable('worktree', String(error.cause))
        )
      )
    if (config.worktree === undefined) {
      yield* runs.retire(runId, 'deleted')
      return yield* unavailable('worktree', 'The worktrees plugin is not loaded.')
    }
    const lastSequence = yield* deps.runEvents.highestSequence.pipe(Effect.orDie)
    yield* deps.turnChanges.track(runId, config.worktree, lastSequence)
    yield* runs
      .openInTab(runId, {
        projectDirectory: metaDirectory,
        select: false,
        owner: { plugin: 'dia-creator', ownsProject: true },
        name: CREATOR_TAB_NAME
      })
      .pipe(
        Effect.catchTag('RunNotFoundError', () =>
          Effect.logWarning('No Creator run to show in a tab', { runId })
        )
      )
    yield* runs.send(runId, text, 'queue')
    yield* Effect.logInfo('Started a Creator thread', { runId, branch: config.worktree.branch })
    return runId
  })

  const reattachUnmerged = Effect.gen(function* () {
    const existing = new Set((yield* runs.list).map((run) => run.runId))
    const unmerged = (yield* deps.turnChanges.unmerged).filter(({ runId }) => existing.has(runId))
    const reattached = yield* Effect.filter(unmerged, ({ runId, worktree }) =>
      deps.gitOps.reattachWorktree(worktree, runId).pipe(
        Effect.tap(() =>
          Effect.logInfo('Reattached an unmerged Creator worktree', {
            runId,
            path: worktree.path
          })
        ),
        Effect.as(true),
        Effect.catchTag('WorktreeReattachError', (error) =>
          Effect.as(
            Effect.logWarning('Could not reattach a Creator worktree', {
              runId,
              error: String(error.cause)
            }),
            false
          )
        )
      )
    )
    const failed = (yield* deps.plugins.list).filter(
      (info) =>
        info.status._tag === 'Failed' &&
        info.origin === 'override' &&
        reattached.some(({ worktree }) => Option.isSome(relativeInside(worktree.path, info.root)))
    )
    yield* Effect.forEach(
      failed,
      (info) =>
        deps.plugins.reload(info.name).pipe(
          Effect.tap((reloaded) =>
            Effect.logInfo('Reloaded a plugin from a reattached Creator worktree', {
              plugin: info.name,
              status: reloaded.status._tag
            })
          )
        ),
      { discard: true }
    )
  })

  return { start, reattachUnmerged }
}
