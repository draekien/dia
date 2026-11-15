// @vitest-environment jsdom
import { ProjectId, type Workspace } from '@shared/domain/project'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { fakeInject } from '@shared/plugin/plugin-registry.fake'
import { cleanup, render, screen } from '@testing-library/react'
import { Effect, Option, Stream } from 'effect'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setPluginRegistry } from '../lib/slots'
import { useTabOpenedFromNewAgent } from '../lib/tab-opened-from-new-agent'
import { NewThreadView, TabView, type View } from '../lib/view'
import { TabContent } from './tab-content'

const shown = vi.hoisted(() => ({
  view: undefined as View | undefined,
  workspace: undefined as Workspace | undefined
}))

vi.mock('../plugin-api', () => ({
  useView: () => shown.view,
  useWorkspace: () => shown.workspace
}))
vi.mock('./window-status', () => ({ WindowStatus: () => null }))

const PROJECT_ID = ProjectId.make('00000000-0000-4000-8000-000000000001')
const PANE = '00000000-0000-4000-8000-000000000101'
const DRAFT = '00000000-0000-4000-8000-0000000000d1'
const workspace: Workspace = {
  projects: [
    {
      project: {
        projectId: PROJECT_ID,
        directory: 'F:/Dev/dia',
        directoryKey: 'f:/dev/dia',
        displayName: 'dia',
        isGitRepo: true
      },
      tabs: []
    }
  ],
  visibleTab: null
}

const registryWithMainTab = (filler: ComponentType | undefined): PluginRegistry => ({
  list: () => Effect.succeed([]),
  start: () => Effect.void,
  load: () => Effect.die(new Error('not used')),
  unload: () => Effect.die(new Error('not used')),
  use: () => Effect.die(new Error('use should not be called in these tests')),
  inject: fakeInject((key) =>
    key === 'slot:main.tab' && filler !== undefined
      ? Option.some({ plugin: 'chat', component: filler })
      : Option.none()
  ),
  changes: Stream.never
})

function ChatStandIn() {
  return <p>{useTabOpenedFromNewAgent() ? 'chat, focus composer' : 'chat'}</p>
}

const show = (view: View) => {
  shown.view = view
  shown.workspace = workspace
  return <TabContent />
}

afterEach(cleanup)

describe('TabContent', () => {
  it('renders the main.tab filler for a tab', () => {
    setPluginRegistry(registryWithMainTab(ChatStandIn))

    render(show(TabView.make({ paneId: PANE })))

    expect(screen.getByText('chat')).toBeTruthy()
  })

  it('shows that no chat plugin is loaded for a tab while main.tab is empty', () => {
    setPluginRegistry(registryWithMainTab(undefined))

    render(show(TabView.make({ paneId: PANE })))

    expect(screen.getByRole('heading', { name: 'No chat plugin is loaded' })).toBeTruthy()
  })

  it('renders the main.tab filler for the new-thread page', () => {
    setPluginRegistry(registryWithMainTab(ChatStandIn))

    render(show(NewThreadView.make({ draftId: DRAFT })))

    expect(screen.getByText('chat')).toBeTruthy()
  })

  it('shows that no chat plugin is loaded for the new-thread page while main.tab is empty', () => {
    setPluginRegistry(registryWithMainTab(undefined))

    render(show(NewThreadView.make({ draftId: DRAFT })))

    expect(screen.getByRole('heading', { name: 'No chat plugin is loaded' })).toBeTruthy()
  })

  it('tells the main.tab filler the tab was opened from the new-thread page', () => {
    setPluginRegistry(registryWithMainTab(ChatStandIn))
    const { rerender } = render(show(NewThreadView.make({ draftId: DRAFT })))

    rerender(show(TabView.make({ paneId: PANE })))

    expect(screen.getByText('chat, focus composer')).toBeTruthy()
  })
})
