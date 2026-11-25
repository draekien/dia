// @vitest-environment jsdom

import { TooltipProvider } from '@dia/renderer-plugin'
import {
  UpdateDownloading,
  UpdateIdle,
  UpdateReady,
  type UpdateStatus
} from '@shared/domain/update'
import { UpdateStatusChanged } from '@shared/ipc/contract'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateEntry } from './update-entry'
import { VersionEntry } from './version-entry'

const APP_VERSION = '0.42.0'

let pushStatus: (status: UpdateStatus) => void
const installUpdate = vi.fn()

function stubBridge(seed: UpdateStatus) {
  vi.stubGlobal('dia', {
    getAppVersion: () => Promise.resolve(APP_VERSION),
    getUpdateStatus: () => Promise.resolve(seed),
    onUpdateStatusChanged: (listener: (event: UpdateStatusChanged) => void) => {
      pushStatus = (status) => listener(UpdateStatusChanged.make({ status }))
      return () => {}
    },
    checkForUpdates: () => {},
    installUpdate
  })
}

const show = (entry: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>{entry}</TooltipProvider>
    </QueryClientProvider>
  )

beforeEach(() => stubBridge(UpdateIdle.make({})))

afterEach(() => {
  cleanup()
  installUpdate.mockReset()
  vi.unstubAllGlobals()
})

describe('VersionEntry', () => {
  it('shows the running version prefixed with v', async () => {
    show(<VersionEntry />)

    expect(await screen.findByRole('button', { name: 'v0.42.0' })).toBeTruthy()
  })

  it('opens the About dia dialog when clicked', async () => {
    show(<VersionEntry />)

    fireEvent.click(await screen.findByRole('button', { name: 'v0.42.0' }))

    expect(await screen.findByRole('dialog', { name: 'About dia' })).toBeTruthy()
  })
})

describe('UpdateEntry', () => {
  it('renders nothing while no update has been reported', async () => {
    const { container } = show(<UpdateEntry />)
    await act(async () => {})

    expect(container.textContent).toBe('')
  })

  it('shows download progress rounded to a whole percent', async () => {
    stubBridge(UpdateDownloading.make({ percent: 41.6 }))
    show(<UpdateEntry />)

    expect(await screen.findByText('Updating… 42%')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers Restart to update once the update is downloaded, and installs it on click', async () => {
    show(<UpdateEntry />)
    await act(async () => {})
    act(() => pushStatus(UpdateReady.make({ version: '0.43.0' })))

    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }))

    expect(installUpdate).toHaveBeenCalledTimes(1)
  })
})
