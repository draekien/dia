// @vitest-environment jsdom

import type { SlashCommandInfo } from '@shared/domain/slash-command'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSlashCommands } from './use-slash-commands'

const review: SlashCommandInfo = {
  name: 'review',
  description: 'Review',
  argumentHint: '',
  aliases: []
}
const getSlashCommands = vi.fn()

beforeEach(() => {
  getSlashCommands.mockReset()
  vi.stubGlobal('dia', { adapter: { getSlashCommands } })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const wrapperFor =
  (client: QueryClient) =>
  ({ children }: { readonly children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

describe('useSlashCommands', () => {
  it('reads once for a second mount with the same cwd inside the stale time', async () => {
    getSlashCommands.mockResolvedValue([review])
    const client = newClient()
    const first = renderHook(() => useSlashCommands('dia-claude-code', '/repo'), {
      wrapper: wrapperFor(client)
    })
    await waitFor(() => expect(first.result.current.commands).toEqual([review]))

    const second = renderHook(() => useSlashCommands('dia-claude-code', '/repo'), {
      wrapper: wrapperFor(client)
    })

    expect(second.result.current.commands).toEqual([review])
    expect(getSlashCommands).toHaveBeenCalledTimes(1)
  })

  it('reads again on the next mount after an empty answer', async () => {
    getSlashCommands.mockResolvedValueOnce([]).mockResolvedValueOnce([review])
    const client = newClient()
    const first = renderHook(() => useSlashCommands('dia-claude-code', '/repo'), {
      wrapper: wrapperFor(client)
    })
    await waitFor(() => expect(first.result.current.loading).toBe(false))

    const second = renderHook(() => useSlashCommands('dia-claude-code', '/repo'), {
      wrapper: wrapperFor(client)
    })

    await waitFor(() => expect(second.result.current.commands).toEqual([review]))
    expect(getSlashCommands).toHaveBeenCalledTimes(2)
  })

  it('does not read on a window focus', async () => {
    getSlashCommands.mockResolvedValue([review])
    const client = newClient()
    const { result } = renderHook(() => useSlashCommands('dia-claude-code', '/repo'), {
      wrapper: wrapperFor(client)
    })
    await waitFor(() => expect(result.current.loading).toBe(false))

    focusManager.setFocused(false)
    focusManager.setFocused(true)

    expect(getSlashCommands).toHaveBeenCalledTimes(1)
  })

  it('reads nothing and is not loading for a null cwd', () => {
    const { result } = renderHook(() => useSlashCommands('dia-claude-code', null), {
      wrapper: wrapperFor(newClient())
    })

    expect(result.current).toEqual({ commands: [], loading: false })
    expect(getSlashCommands).not.toHaveBeenCalled()
  })

  it('is loading until the first read ends', async () => {
    getSlashCommands.mockResolvedValue([review])
    const { result } = renderHook(() => useSlashCommands('dia-claude-code', '/repo'), {
      wrapper: wrapperFor(newClient())
    })

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('gives an empty list and stops loading when the read rejects', async () => {
    getSlashCommands.mockRejectedValue(new Error('no claude'))
    const { result } = renderHook(() => useSlashCommands('dia-claude-code', '/repo'), {
      wrapper: wrapperFor(newClient())
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.commands).toEqual([])
  })
})
