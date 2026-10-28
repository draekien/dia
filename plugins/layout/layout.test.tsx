// @vitest-environment jsdom
import { MAIN, MAIN_HEADER, SIDEBAR, Sidebar, SidebarRail, useSidebar } from '@dia/renderer-plugin'
import { setKernelDefault } from '@renderer/lib/slots'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Layout } from './layout'

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
  localStorage.clear()
  setKernelDefault(SIDEBAR, TestSidebar)
  setKernelDefault(MAIN_HEADER, () => <p>header content</p>)
  setKernelDefault(MAIN, () => <p>main content</p>)
})

afterEach(cleanup)

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
