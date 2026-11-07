// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginBoundary } from './plugin-boundary'
import { PluginFailed } from './plugin-failed'

const page = { broken: false }

function Flaky() {
  if (page.broken) {
    throw new TypeError("Cannot read properties of undefined (reading 'remoteUrl')")
  }
  return <p>meta repo page</p>
}

const renderFlaky = () =>
  render(
    <PluginBoundary
      plugin="meta"
      at="settings.pages"
      resetKey={Flaky}
      fallback={(error, retry) => <PluginFailed plugin="meta" error={error} onRetry={retry} />}
    >
      <Flaky />
    </PluginBoundary>
  )

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PluginBoundary with PluginFailed', () => {
  it('names the plugin and shows the thrown error in place of the component', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    page.broken = true

    renderFlaky()

    expect([
      screen.getByText('The meta plugin failed to show this').textContent,
      screen.getByText(/^TypeError:/).textContent
    ]).toEqual([
      'The meta plugin failed to show this',
      "TypeError: Cannot read properties of undefined (reading 'remoteUrl')"
    ])
  })

  it('renders the component again when Try again is pressed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    page.broken = true
    renderFlaky()
    page.broken = false

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByText('meta repo page')).toBeTruthy()
  })

  it('renders nothing when given no fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    page.broken = true

    const { container } = render(
      <PluginBoundary plugin="meta" at="layout.dialogs" resetKey={Flaky}>
        <Flaky />
      </PluginBoundary>
    )

    expect(container.innerHTML).toBe('')
  })
})
