// @vitest-environment jsdom
import { Toaster } from '@dia/renderer-plugin'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Active,
  Kept,
  LedgerEntry,
  type LedgerState,
  LedgerStateChanged,
  NeedsDecision,
  Removed
} from './calls'
import { makeWorktreesAtom, WorktreesSettings } from './settings-page'

const ctx = { name: 'worktrees' }

const encodeList = Schema.encodeSync(Schema.toCodecJson(Schema.Array(LedgerEntry)))
const encodeChanged = Schema.encodeSync(Schema.toCodecJson(LedgerStateChanged))

const entry = (name: string, label: string, state: LedgerState): LedgerEntry => ({
  info: { path: `/trees/${name}`, branch: `dia/${name}`, sourceRepo: '/repo' },
  owner: { paneId: 'p', label },
  state,
  updatedAt: 0
})

const installHost = (
  list: ReadonlyArray<LedgerEntry>,
  reply: () => unknown = () => ({ _tag: 'Success', value: null })
) => {
  const watchers = new Set<(value: unknown) => void>()
  const call = vi.fn(async (_plugin: string, _tag: string, _payload: unknown) => reply())
  Object.assign(window, {
    dia: {
      plugins: {
        call,
        subscribe: (
          _plugin: string,
          _tag: string,
          _payload: unknown,
          onValue: (v: unknown) => void
        ) => {
          watchers.add(onValue)
          queueMicrotask(() => onValue(encodeList(list)))
          return () => watchers.delete(onValue)
        },
        onStatusChanged: () => () => {}
      }
    }
  })
  return {
    call,
    push: (next: ReadonlyArray<LedgerEntry>) =>
      act(() => {
        for (const watcher of watchers) watcher(encodeList(next))
      })
  }
}

const renderPage = async () => {
  render(
    <Toaster>
      <WorktreesSettings ctx={ctx} worktreesAtom={makeWorktreesAtom(ctx)} />
    </Toaster>
  )
  await screen.findByRole('list')
}

const buttonsOf = (branch: string) =>
  Array.from(screen.getByText(branch).closest('li')?.querySelectorAll('button') ?? []).map(
    (button) => button.textContent
  )

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('Worktrees settings page', () => {
  it('lists each worktree with its label and state', async () => {
    installHost([
      entry('live', 'Tab · dia', Active.make({})),
      entry('dirty', 'Issue · Fix login', NeedsDecision.make({ changedFiles: 1 }))
    ])

    await renderPage()

    expect(screen.getByText('dia/live').closest('li')?.textContent).toContain('Tab · dia')
    expect(screen.getByText('dia/dirty').closest('li')?.textContent).toContain(
      'Issue · Fix login' + 'Needs your decision, 1 changed file'
    )
  })

  it('offers Keep and Discard for NeedsDecision, only Discard for Kept, and nothing otherwise', async () => {
    installHost([
      entry('a', 'l', NeedsDecision.make({ changedFiles: 2 })),
      entry('b', 'l', Kept.make({ changedFiles: 2 })),
      entry('c', 'l', Active.make({})),
      entry('d', 'l', Removed.make({}))
    ])

    await renderPage()

    expect(['dia/a', 'dia/b', 'dia/c', 'dia/d'].map(buttonsOf)).toEqual([
      ['Keep worktree', 'Discard and remove'],
      ['Discard and remove'],
      [],
      []
    ])
  })

  it('sends DiscardWorktree with the worktree path', async () => {
    const host = installHost([entry('a', 'l', Kept.make({ changedFiles: 2 }))])
    await renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Discard and remove' }))

    await waitFor(() =>
      expect(host.call.mock.calls).toEqual([['worktrees', 'DiscardWorktree', { path: '/trees/a' }]])
    )
  })

  it('sends KeepWorktree with the worktree path', async () => {
    const host = installHost([entry('a', 'l', NeedsDecision.make({ changedFiles: 2 }))])
    await renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Keep worktree' }))

    await waitFor(() =>
      expect(host.call.mock.calls).toEqual([['worktrees', 'KeepWorktree', { path: '/trees/a' }]])
    )
  })

  it('shows a toast naming the current state when the worktree changed, and follows the stream', async () => {
    const host = installHost([entry('a', 'l', NeedsDecision.make({ changedFiles: 2 }))], () => ({
      _tag: 'Failure',
      error: {
        _tag: 'PluginCallFailed',
        error: encodeChanged(new LedgerStateChanged({ path: '/trees/a', state: Active.make({}) }))
      }
    }))
    await renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Discard and remove' }))
    await host.push([entry('a', 'l', Active.make({}))])

    expect(await screen.findByText('dia/a is now in use')).toBeTruthy()
    expect(buttonsOf('dia/a')).toEqual([])
  })
})
