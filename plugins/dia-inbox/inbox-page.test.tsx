// @vitest-environment jsdom
// @effect-diagnostics asyncFunction:off -- the fake stands in for the Promise-based window.dia bridge.
import { Attention, type PluginServices, type PluginSetup } from '@dia/plugin'
import { RequestCardKey } from '@dia-plugin/dia-chat/slots'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startRendererRegistry } from '../../src/renderer/src/lib/renderer-registry.fake'
import { RequestCard } from '../dia-chat/request-card'
import { InboxItem } from './calls'
import { InboxPage, makeInboxAtom } from './inbox-page'

const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'
const encodeItems = Schema.encodeSync(Schema.toCodecJson(Schema.Array(InboxItem)))

const provideCard: PluginSetup<PluginServices> = (ctx) => ctx.provide(RequestCardKey, RequestCard)

const installHost = (items: ReadonlyArray<InboxItem>) => {
  const call = vi.fn(async () => ({ _tag: 'Success', value: null }))
  const subscribe = (
    _plugin: string,
    _tag: string,
    _payload: unknown,
    onValue: (v: unknown) => void
  ) => {
    queueMicrotask(() => onValue(encodeItems(items)))
    return () => {}
  }
  Object.assign(window, {
    dia: {
      plugins: { call, subscribe, onStatusChanged: () => () => {} },
      getWorkspace: async () => ({ projects: [], visibleTab: null }),
      onWorkspaceChanged: () => () => {},
      onAgentSummariesReplaced: () => () => {},
      selectTab: () => {}
    }
  })
  return call
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('inbox page', () => {
  it('sends Allow on a permission request of a run with no tab to dia-runs for that run', async () => {
    const call = installHost([
      {
        runId: RUN,
        cwd: '/work/dia',
        request: Attention.PermissionRequest.make({
          requestId: 'p1',
          toolName: 'Bash',
          input: { command: 'ls' }
        })
      }
    ])
    await startRendererRegistry({ 'dia-chat': provideCard })
    render(<InboxPage inboxAtom={makeInboxAtom({ name: 'dia-inbox' })} />)
    await waitFor(() => screen.getByRole('button', { name: 'Allow' }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    })

    expect(call).toHaveBeenCalledWith('dia-runs', 'ResolvePermission', {
      runId: RUN,
      requestId: 'p1',
      response: { _tag: 'Allow' }
    })
  })

  it('says no agent is waiting when the inbox is empty', async () => {
    installHost([])
    await startRendererRegistry({ 'dia-chat': provideCard })
    render(<InboxPage inboxAtom={makeInboxAtom({ name: 'dia-inbox' })} />)

    expect(await screen.findByText('No agent is waiting for you')).toBeTruthy()
  })
})
