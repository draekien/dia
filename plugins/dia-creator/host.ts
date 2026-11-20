import {
  GitKey,
  type HostPluginContext,
  MetaRepoKey,
  type PluginSetup,
  RunEventsKey,
  RunsKey,
  type ToolScope,
  WorktreesKey
} from '@dia/plugin'
import { AgentAdaptersKey } from '@dia-plugin/dia-agent-adapters/registry'
import { AgentDefinitionRegistryKey } from '@dia-plugin/dia-agent-definitions/registry'
import { ToolsKey } from '@dia-plugin/dia-tools/tools'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { Crypto, Effect, Stream } from 'effect'
import { FollowCreatorThread, MergeCreatorThread, RevertTurn, StartCreatorThread } from './calls'
import { CREATOR_LABEL, registerCreatorDefinition } from './creator-definition'
import { makeCreatorThreads } from './creator-threads'
import { creatorMigrations } from './migrations'
import { makeCreatorTools } from './plugin-tools'
import { makeTurnChanges } from './turn-changes'

const isCreatorScope = (scope: ToolScope) => scope.labels.includes(CREATOR_LABEL)

const metaDirectoryOf = (metaRepo: object) =>
  'directory' in metaRepo && typeof metaRepo.directory === 'string' ? metaRepo.directory : undefined

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    const sql = yield* ctx.database(creatorMigrations)
    yield* ctx.whenProvided([ToolsKey], ({ tools }) =>
      Effect.forEach(
        makeCreatorTools(ctx.plugins),
        (tool) => tools.register(tool, { when: isCreatorScope }),
        { discard: true }
      ).pipe(Effect.tap(() => Effect.logInfo('Creator tools registered')))
    )
    yield* ctx.whenProvided([AgentDefinitionRegistryKey], ({ agentDefinitionRegistry }) =>
      registerCreatorDefinition(agentDefinitionRegistry, ctx.name)
    )
    yield* ctx.whenProvided(
      [
        RunsKey,
        RunEventsKey,
        GitKey,
        MetaRepoKey,
        WorktreesKey,
        AgentDefinitionRegistryKey,
        AgentAdaptersKey
      ],
      ({ runs, runEvents, git, metaRepo, worktrees, agentDefinitionRegistry, agentAdapters }) =>
        Effect.gen(function* () {
          const metaDirectory = metaDirectoryOf(metaRepo)
          if (metaDirectory === undefined) {
            yield* Effect.logWarning(
              'The meta repo plugin reports no directory; Creator mode is off'
            )
            return
          }
          const turnChanges = yield* makeTurnChanges({
            sql,
            git,
            runEvents,
            plugins: ctx.plugins,
            reattach: worktrees.reattachWorktree,
            metaDirectory
          })
          const crypto = yield* Crypto.Crypto
          const threads = makeCreatorThreads({
            runs,
            runEvents,
            git,
            metaDirectory,
            definitions: agentDefinitionRegistry,
            choices: { adapters: agentAdapters, defaultSelection: runs.defaultSelection },
            gitOps: worktrees,
            plugins: ctx.plugins,
            turnChanges,
            newRunId: crypto.randomUUIDv4().pipe(Effect.orDie)
          })
          const events = yield* runEvents.subscribe
          yield* threads.reattachUnmerged
          yield* turnChanges.catchUp
          yield* events.pipe(
            Stream.runForEach((committed) =>
              turnChanges.fold(committed).pipe(
                Effect.catchDefect((defect) =>
                  Effect.logError('Could not fold a Creator run event', {
                    runId: committed.runId,
                    sequence: committed.sequence,
                    defect: String(defect)
                  })
                )
              )
            ),
            Effect.forkScoped
          )
          yield* ctx.serve(StartCreatorThread, ({ text }) => threads.start(text))
          yield* ctx.serve(FollowCreatorThread, ({ runId }) => turnChanges.follow(runId))
          yield* ctx.serve(RevertTurn, ({ runId, turnId }) => turnChanges.revert(runId, turnId))
          yield* ctx.serve(MergeCreatorThread, ({ runId }) => turnChanges.merge(runId))
          yield* Effect.logInfo('Creator mode serves its threads', { metaDirectory })
        }).pipe(Effect.provide(NodeCrypto.layer))
    )
  })

export default setup
