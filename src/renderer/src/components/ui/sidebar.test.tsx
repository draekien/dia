// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sidebar, SidebarProvider, SidebarRail, type SidebarWidth } from './sidebar'

afterEach(cleanup)

const resizeOf = (overrides: Partial<SidebarWidth> = {}): SidebarWidth => ({
  width: undefined,
  defaultWidth: 288,
  minWidth: 224,
  maxWidth: 512,
  onWidthChange: vi.fn(),
  ...overrides
})

const renderRail = (resize: SidebarWidth) => {
  render(
    <SidebarProvider resize={resize}>
      <Sidebar>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  )
  return screen.getByRole('separator', { name: 'Resize sidebar' })
}

describe('SidebarRail with resize', () => {
  it('starts from the default width when none is saved', () => {
    const rail = renderRail(resizeOf())

    expect(rail.getAttribute('aria-valuenow')).toBe('288')
    expect(rail.getAttribute('aria-valuemin')).toBe('224')
    expect(rail.getAttribute('aria-valuemax')).toBe('512')
  })

  it('applies a saved width above the maximum as the maximum', () => {
    const rail = renderRail(resizeOf({ width: 9999 }))

    expect(rail.getAttribute('aria-valuenow')).toBe('512')
  })

  it('steps right by 16 from the default width', () => {
    const resize = resizeOf()
    fireEvent.keyDown(renderRail(resize), { key: 'ArrowRight' })

    expect(resize.onWidthChange).toHaveBeenCalledExactlyOnceWith(304)
  })

  it('steps left by 16 from a saved width', () => {
    const resize = resizeOf({ width: 300 })
    fireEvent.keyDown(renderRail(resize), { key: 'ArrowLeft' })

    expect(resize.onWidthChange).toHaveBeenCalledExactlyOnceWith(284)
  })

  it('clamps a left step at the minimum', () => {
    const resize = resizeOf({ width: 230 })
    fireEvent.keyDown(renderRail(resize), { key: 'ArrowLeft' })

    expect(resize.onWidthChange).toHaveBeenCalledExactlyOnceWith(224)
  })

  it('clamps a right step at the maximum', () => {
    const resize = resizeOf({ width: 505 })
    fireEvent.keyDown(renderRail(resize), { key: 'ArrowRight' })

    expect(resize.onWidthChange).toHaveBeenCalledExactlyOnceWith(512)
  })

  it('resets on Home', () => {
    const resize = resizeOf({ width: 400 })
    fireEvent.keyDown(renderRail(resize), { key: 'Home' })

    expect(resize.onWidthChange).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('resets on double click', () => {
    const resize = resizeOf({ width: 400 })
    fireEvent.doubleClick(renderRail(resize))

    expect(resize.onWidthChange).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('ignores other keys and single clicks', () => {
    const resize = resizeOf()
    const rail = renderRail(resize)
    fireEvent.keyDown(rail, { key: 'a' })
    fireEvent.click(rail)

    expect(resize.onWidthChange).not.toHaveBeenCalled()
  })

  it('sets --sidebar-width on the wrapper to the clamped width', () => {
    renderRail(resizeOf({ width: 100 }))

    const wrapper = document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]')
    expect(wrapper?.style.getPropertyValue('--sidebar-width')).toBe('224px')
  })
})
