import { ProjectId } from '@shared/domain/project'
import type { PluginServices } from '@shared/plugin/api'
import { Effect, Exit, Option, Scope } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelNewAgent, newAgent, openPage } from './actions'
import { addPage, type Page, pagesAtom } from './pages'
import { appRegistry, newAgentFormAtom, openPageAtom } from './workspace-atoms'

const PROJECT = ProjectId.make('00000000-0000-4000-8000-000000000001')
const PANE_A = '00000000-0000-4000-8000-00000000000a'

const services = (name: string): PluginServices => ({
  name,
  provide: () => Effect.void,
  inject: () => Effect.succeedNone,
  whenProvided: () => Effect.void
})

const page = (id: string, order: number): Page => ({
  id,
  label: id,
  icon: () => null,
  order,
  component: () => null
})

const addInScope = (plugin: string, added: Page) =>
  Effect.runSync(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* addPage(services(plugin), added).pipe(Scope.provide(scope))
      return scope
    })
  )

const close = (scope: Scope.Closeable) => Effect.runSync(Scope.close(scope, Exit.void))

const listedIds = () => appRegistry.get(pagesAtom).map((entry) => entry.key.id)

const openPageId = () =>
  Option.map(appRegistry.get(openPageAtom), (open) => open.key.id).pipe(Option.getOrNull)

afterEach(() => {
  appRegistry.reset()
  vi.unstubAllGlobals()
})

describe('addPage', () => {
  it('lists pages by ascending order, whatever order they were added in', () => {
    addInScope('org', page('roster', 20))
    addInScope('example', page('greeting', 10))

    expect(listedIds()).toEqual(['greeting', 'roster'])
  })

  it('keeps the order pages were added in when their order is equal', () => {
    addInScope('org', page('roster', 10))
    addInScope('example', page('greeting', 10))

    expect(listedIds()).toEqual(['roster', 'greeting'])
  })

  it("removes the page when its plugin's scope closes", () => {
    const scope = addInScope('example', page('greeting', 10))

    close(scope)

    expect(listedIds()).toEqual([])
  })

  it("closes the open page when its plugin's scope closes", () => {
    vi.stubGlobal('window', { dia: { selectTab: () => {} } })
    appRegistry.set(newAgentFormAtom, Option.some({ projectId: PROJECT, shownBefore: null }))
    const scope = addInScope('example', page('greeting', 10))
    openPage({ plugin: 'example', id: 'greeting' })

    close(scope)

    expect(appRegistry.get(openPageAtom)).toEqual(Option.none())
  })

  it('leaves the open page open when another plugin removes its page', () => {
    vi.stubGlobal('window', { dia: { selectTab: () => {} } })
    appRegistry.set(newAgentFormAtom, Option.some({ projectId: PROJECT, shownBefore: null }))
    addInScope('example', page('greeting', 10))
    const other = addInScope('org', page('roster', 20))
    openPage({ plugin: 'example', id: 'greeting' })

    close(other)

    expect(openPageId()).toBe('greeting')
  })

  it('does not reopen a page closed by a reload when the plugin adds it again', () => {
    vi.stubGlobal('window', { dia: { selectTab: () => {} } })
    appRegistry.set(newAgentFormAtom, Option.some({ projectId: PROJECT, shownBefore: null }))
    const scope = addInScope('example', page('greeting', 10))
    openPage({ plugin: 'example', id: 'greeting' })

    close(scope)
    addInScope('example', page('greeting', 10))

    expect(openPageId()).toBeNull()
  })
})

describe('openPage', () => {
  it('keeps the tab the New agent form opened over, and closes the form', () => {
    vi.stubGlobal('window', { dia: { selectTab: () => {} } })
    appRegistry.set(newAgentFormAtom, Option.some({ projectId: PROJECT, shownBefore: PANE_A }))

    openPage({ plugin: 'example', id: 'greeting' })

    expect(appRegistry.get(openPageAtom)).toEqual(
      Option.some({ key: { plugin: 'example', id: 'greeting' }, shownBefore: PANE_A })
    )
    expect(appRegistry.get(newAgentFormAtom)).toEqual(Option.none())
  })

  it('tells the Host that no tab is visible behind the page', () => {
    const selectTab = vi.fn()
    vi.stubGlobal('window', { dia: { selectTab } })
    appRegistry.set(newAgentFormAtom, Option.some({ projectId: PROJECT, shownBefore: PANE_A }))

    openPage({ plugin: 'example', id: 'greeting' })

    expect(selectTab).toHaveBeenCalledWith(null)
  })

  it('keeps the tab an earlier open page hid', () => {
    vi.stubGlobal('window', { dia: { selectTab: () => {} } })
    appRegistry.set(
      openPageAtom,
      Option.some({ key: { plugin: 'org', id: 'roster' }, shownBefore: PANE_A })
    )

    openPage({ plugin: 'example', id: 'greeting' })

    expect(Option.map(appRegistry.get(openPageAtom), (open) => open.shownBefore)).toEqual(
      Option.some(PANE_A)
    )
  })
})

describe('newAgent over an open page', () => {
  it('returns to the tab the page hid when the form is cancelled', () => {
    const selectTab = vi.fn()
    vi.stubGlobal('window', { dia: { selectTab } })
    appRegistry.set(
      openPageAtom,
      Option.some({ key: { plugin: 'example', id: 'greeting' }, shownBefore: PANE_A })
    )

    newAgent(PROJECT)
    cancelNewAgent()

    expect(selectTab).toHaveBeenLastCalledWith(PANE_A)
  })
})

describe('addPage across a reload that adds the page before the old scope closes', () => {
  it('leaves the open page open', () => {
    vi.stubGlobal('window', { dia: { selectTab: () => {} } })
    const old = addInScope('example', page('greeting', 10))
    openPage({ plugin: 'example', id: 'greeting' })
    addInScope('example', page('greeting', 10))

    close(old)

    expect(openPageId()).toBe('greeting')
  })
})
