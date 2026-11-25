// @vitest-environment jsdom
import type { PluginServices, PluginSetup } from '@dia/plugin'
import {
  addEntry,
  MAIN,
  MAIN_HEADER,
  SIDEBAR,
  Sidebar,
  SidebarRail,
  useSidebar
} from '@dia/renderer-plugin'
import { type StatusBarItem, StatusBarItemsSlot } from '@dia-plugin/dia-layout/slots'
import { setKernelDefault } from '@renderer/lib/slots'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startRendererRegistry } from '../../src/renderer/src/lib/renderer-registry.fake'
import { Layout } from './layout'
import layout from './renderer'

function TestSidebar() {
  const { state } = useSidebar()
  return (
    <Sidebar>
      <p>sidebar is {state}</p>
      <SidebarRail />
    </Sidebar>
  )
}

beforeEach(() => {
  Object.assign(window, { dia: { workspaceProblems: { list: async () => [] } } })
  localStorage.clear()
  setKernelDefault(SIDEBAR, TestSidebar)
  setKernelDefault(MAIN_HEADER, () => <p>header content</p>)
  setKernelDefault(MAIN, () => <p>main content</p>)
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

const rail = () => screen.getByRole('separator', { name: 'Resize sidebar' })
const wrapper = () =>
  document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]') as HTMLElement

describe('Layout', () => {
  it('renders the header slot in the card header and the main slot below it', () => {
    render(<Layout />)

    expect(screen.getByRole('banner').textContent).toContain('header content')
    expect(screen.getByText('main content')).toBeTruthy()
  })

  describe('sidebar open state', () => {
    it('starts expanded when nothing is stored', () => {
      render(<Layout />)

      expect(screen.getByText('sidebar is expanded')).toBeTruthy()
    })

    it('starts collapsed when dia.sidebar.open is 0', () => {
      localStorage.setItem('dia.sidebar.open', '0')
      render(<Layout />)

      expect(screen.getByText('sidebar is collapsed')).toBeTruthy()
    })

    it('migrates a collapsed legacy rail key and stores it under the new key', () => {
      localStorage.setItem('dia.agent-overview.rail', '1')
      render(<Layout />)

      expect(screen.getByText('sidebar is collapsed')).toBeTruthy()
      expect(localStorage.getItem('dia.sidebar.open')).toBe('0')
    })

    it('migrates an expanded legacy rail key', () => {
      localStorage.setItem('dia.agent-overview.rail', '0')
      render(<Layout />)

      expect(screen.getByText('sidebar is expanded')).toBeTruthy()
      expect(localStorage.getItem('dia.sidebar.open')).toBe('1')
    })

    it('prefers dia.sidebar.open over the legacy key', () => {
      localStorage.setItem('dia.sidebar.open', '1')
      localStorage.setItem('dia.agent-overview.rail', '1')
      render(<Layout />)

      expect(screen.getByText('sidebar is expanded')).toBeTruthy()
    })

    it('persists the state when Ctrl B toggles the sidebar', () => {
      render(<Layout />)
      fireEvent.keyDown(window, { key: 'b', ctrlKey: true })

      expect(screen.getByText('sidebar is collapsed')).toBeTruthy()
      expect(localStorage.getItem('dia.sidebar.open')).toBe('0')
    })

    it.each(['shiftKey', 'altKey'])('ignores Ctrl B with %s held', (modifier) => {
      render(<Layout />)
      fireEvent.keyDown(window, { key: 'b', ctrlKey: true, [modifier]: true })

      expect(screen.getByText('sidebar is expanded')).toBeTruthy()
    })

    it('persists the state when the header toggle is clicked', () => {
      render(<Layout />)
      fireEvent.click(within(screen.getByRole('banner')).getByRole('button'))

      expect(screen.getByText('sidebar is collapsed')).toBeTruthy()
      expect(localStorage.getItem('dia.sidebar.open')).toBe('0')
    })
  })

  describe('sidebar width', () => {
    it('defaults to 288px when nothing is stored', () => {
      render(<Layout />)

      expect(wrapper().style.getPropertyValue('--sidebar-width')).toBe('288px')
    })

    it('applies a stored 9999 as 512', () => {
      localStorage.setItem('dia.sidebar.width', '9999')
      render(<Layout />)

      expect(wrapper().style.getPropertyValue('--sidebar-width')).toBe('512px')
      expect(rail().getAttribute('aria-valuenow')).toBe('512')
    })

    it('ignores a stored width that is not a number', () => {
      localStorage.setItem('dia.sidebar.width', 'wide')
      render(<Layout />)

      expect(wrapper().style.getPropertyValue('--sidebar-width')).toBe('288px')
    })

    it('stores the width when the rail steps right from the default', () => {
      render(<Layout />)
      fireEvent.keyDown(rail(), { key: 'ArrowRight' })

      expect(localStorage.getItem('dia.sidebar.width')).toBe('304')
      expect(wrapper().style.getPropertyValue('--sidebar-width')).toBe('304px')
    })

    it('removes the stored width when the rail resets', () => {
      localStorage.setItem('dia.sidebar.width', '400')
      render(<Layout />)
      fireEvent.doubleClick(rail())

      expect(localStorage.getItem('dia.sidebar.width')).toBeNull()
      expect(wrapper().style.getPropertyValue('--sidebar-width')).toBe('288px')
    })
  })
})

const entry = (id: string, side: StatusBarItem['side'], order: number): StatusBarItem => ({
  id,
  side,
  order,
  component: () => <span>{id}</span>
})

const adds =
  (...items: ReadonlyArray<StatusBarItem>): PluginSetup<PluginServices> =>
  (ctx) =>
    Effect.forEach(items, (item) => addEntry(ctx, StatusBarItemsSlot, item), { discard: true })

const statusBar = () => screen.queryByRole('contentinfo', { name: 'Status bar' })

const groups = () => {
  const [start, end] = Array.from(statusBar()?.children ?? [])
  return { start: start?.textContent, end: end?.textContent }
}

describe('status bar', () => {
  it('is not drawn while no plugin adds an entry', async () => {
    await startRendererRegistry({ layout })
    render(<Layout />)

    expect(statusBar()).toBeNull()
  })

  it('places start entries left to right and end entries right to left by ascending order', async () => {
    await startRendererRegistry({
      layout,
      example: adds(
        entry('version', 'start', 20),
        entry('update', 'start', 10),
        entry('errors', 'end', 0),
        entry('branch', 'end', 5)
      )
    })
    render(<Layout />)

    expect(groups()).toEqual({ start: 'updateversion', end: 'brancherrors' })
  })

  it('shows a retry marker naming the plugin for an entry that throws, and still draws the others', async () => {
    const throws: StatusBarItem = {
      id: 'broken',
      side: 'start',
      order: 0,
      component: () => {
        throw new Error('no status')
      }
    }
    await startRendererRegistry({
      layout,
      broken: adds(throws),
      example: adds(entry('version', 'start', 10))
    })
    render(<Layout />)

    expect(
      within(statusBar() as HTMLElement).getByRole('button', { name: /broken plugin failed/ })
        .textContent
    ).toBe('broken')
    expect(groups().start).toBe('brokenversion')
  })

  it('drops an entry when the plugin that added it unloads', async () => {
    const registry = await startRendererRegistry({
      layout,
      example: adds(entry('version', 'start', 10)),
      git: adds(entry('branch', 'end', 0))
    })
    render(<Layout />)

    await act(() => Effect.runPromise(registry.unload('git')))

    expect(groups()).toEqual({ start: 'version', end: '' })
  })

  it('disappears when its last entry is removed', async () => {
    const registry = await startRendererRegistry({
      layout,
      example: adds(entry('version', 'start', 10))
    })
    render(<Layout />)

    await act(() => Effect.runPromise(registry.unload('example')))

    expect(statusBar()).toBeNull()
  })
})
