import type { PluginServices, PluginSetup } from '@dia/plugin'
import {
  actions,
  addEntry,
  callHost,
  closeSettings,
  followHost,
  PluginThreadTarget
} from '@dia/renderer-plugin'
import { ThreadTargetsSlot, TurnFootersSlot } from '@dia-plugin/dia-chat/slots'
import { OpenRunInTab } from '@dia-plugin/dia-runs/calls'
import { PluginPageActionsSlot } from '@dia-plugin/dia-settings/slots'
import { MetaThreadSourcesSlot } from '@dia-plugin/dia-threads/slots'
import { Effect } from 'effect'
import { Atom } from 'effect/reactivity'
import { HammerIcon } from 'lucide-react'
import { createElement } from 'react'
import { FollowCreatorThread, MergeCreatorThread, RevertTurn, StartCreatorThread } from './calls'
import { TurnChangeLine } from './turn-change-line'

const CREATOR_TARGET = PluginThreadTarget.make({ plugin: 'dia-creator', id: 'creator' })

const UNAVAILABLE = 'Creator mode is not loaded.'

const failureText = (failure: { readonly _tag: string; readonly message?: string }) =>
  failure._tag === 'PluginNotServing' || failure._tag === 'PluginCallInvalid'
    ? UNAVAILABLE
    : (failure.message ?? UNAVAILABLE)

const outcome = <A, E extends { readonly _tag: string; readonly message?: string }>(
  call: Effect.Effect<A, E>,
  action: string
) =>
  Effect.runPromise(
    call.pipe(
      Effect.as(null),
      Effect.catch((failure) =>
        Effect.as(
          Effect.logWarning(`Creator ${action} failed`, { failure: failure._tag }),
          failureText(failure)
        )
      )
    )
  )

const showRun = (runId: string) =>
  callHost('dia-runs', OpenRunInTab, { runId }).pipe(
    Effect.tap(() => Effect.logInfo('Opened a Creator thread in a tab', { runId })),
    Effect.asVoid,
    Effect.catch((failure) =>
      Effect.logWarning('Could not open a Creator thread', { runId, failure: failure._tag })
    )
  )

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const threads = Atom.family((runId: string) =>
      Atom.make(followHost(ctx, FollowCreatorThread, { runId }))
    )
    const newCreatorThread = () => actions.newThread(CREATOR_TARGET)
    yield* addEntry(ctx, ThreadTargetsSlot, {
      id: 'creator',
      order: 20,
      label: 'Creator mode',
      icon: HammerIcon,
      send: (text) =>
        callHost(ctx, StartCreatorThread, { text }).pipe(
          Effect.flatMap(showRun),
          Effect.mapError(failureText)
        )
    })
    yield* addEntry(ctx, MetaThreadSourcesSlot, {
      id: 'creator',
      order: 10,
      owner: 'dia-creator',
      newThreadLabel: 'New Creator thread',
      newThread: newCreatorThread
    })
    yield* addEntry(ctx, PluginPageActionsSlot, {
      id: 'create-plugin',
      order: 10,
      label: 'Create a plugin…',
      icon: HammerIcon,
      run: () => {
        closeSettings()
        newCreatorThread()
      }
    })
    yield* addEntry(ctx, TurnFootersSlot, {
      id: 'creator-changes',
      order: 20,
      component: ({ paneId, messageIds }) =>
        createElement(TurnChangeLine, {
          runId: paneId,
          messageIds,
          threads,
          revert: (runId, turnId) =>
            outcome(callHost(ctx, RevertTurn, { runId, turnId }), 'revert'),
          merge: (runId) => outcome(callHost(ctx, MergeCreatorThread, { runId }), 'merge')
        })
    })
    yield* Effect.logInfo('Creator renderer plugin opened', ctx.name)
  })

export default setup
