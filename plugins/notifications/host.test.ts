import type { HostPluginContext } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import {
  AgentSummary,
  NoActivity,
  StatusFailed,
  StatusNeedsInput
} from '@shared/domain/agent-summary'
import type { AgentNotification } from '@shared/domain/notification'
import { AgentName, ProjectId, type Workspace } from '@shared/domain/project'
import { AgentSummaryChanged } from '@shared/ipc/contract'
import { GlobalEventFrame } from '@shared/ipc/rpc'
import { Effect, Queue, Stream, SubscriptionRef } from 'effect'
import setup from './host'

const BACKGROUND = '00000000-0000-4000-8000-000000000001'
const VISIBLE = '00000000-0000-4000-8000-000000000002'

const tab = (paneId: string, name: string) => ({
  name: AgentName.make(name),
  config: {
    paneId,
    cwd: '/repo',
    model: 'm',
    thinkingLevel: 'adaptive' as const,
    permissionMode: 'default' as const
  },
  archived: false
})

const WORKSPACE: Workspace = {
  projects: [
    {
      project: {
        projectId: ProjectId.make('00000000-0000-4000-8000-0000000000aa'),
        directory: '/repo',
        directoryKey: '/repo',
        displayName: 'dia',
        isGitRepo: true
      },
      tabs: [tab(BACKGROUND, 'brave-otter'), tab(VISIBLE, 'calm-heron')]
    }
  ],
  visibleTab: VISIBLE
}

const summaryFrame = (paneId: string, status: AgentSummary['status']) =>
  GlobalEventFrame.make({
    event: AgentSummaryChanged.make({
      summary: AgentSummary.make({ paneId, status, activity: NoActivity.make({}) })
    })
  })

const harness = Effect.fnUntraced(function* (attendedAtStart: boolean) {
  const events = yield* Queue.unbounded<GlobalEventFrame>()
  const attended = yield* SubscriptionRef.make(attendedAtStart)
  const notified = yield* Queue.unbounded<AgentNotification>()
  const ctx = {
    name: 'notifications',
    events: Stream.fromQueue(events),
    workspace: Stream.make(WORKSPACE),
    window: {
      attended: SubscriptionRef.changes(attended),
      notify: (notification: AgentNotification) => Queue.offer(notified, notification)
    }
  } as unknown as HostPluginContext
  yield* setup(ctx)
  return { events, notified }
})

describe('notifications plugin', () => {
  it.effect('shows one notification per status change, through ctx.window.notify', () =>
    Effect.gen(function* () {
      const { events, notified } = yield* harness(true)
      const request = StatusNeedsInput.make({ reason: 'Allow Bash npm test?' })

      yield* Queue.offer(events, summaryFrame(BACKGROUND, request))
      yield* Queue.offer(events, summaryFrame(BACKGROUND, request))
      yield* Queue.offer(events, summaryFrame(BACKGROUND, StatusFailed.make({ reason: 'boom' })))
      const first = yield* Queue.take(notified)
      const second = yield* Queue.take(notified)

      assert.deepStrictEqual(first, {
        paneId: BACKGROUND,
        title: 'brave-otter in dia',
        body: 'Needs input: Allow Bash npm test?'
      })
      assert.strictEqual(second.body, 'Failed: boom')
    }).pipe(Effect.scoped)
  )

  it.effect('notifies for the visible agent while the window is not attended', () =>
    Effect.gen(function* () {
      const { events, notified } = yield* harness(false)

      yield* Queue.offer(events, summaryFrame(VISIBLE, StatusFailed.make({ reason: 'boom' })))
      const shown = yield* Queue.take(notified)

      assert.strictEqual(shown.paneId, VISIBLE)
    }).pipe(Effect.scoped)
  )
})
