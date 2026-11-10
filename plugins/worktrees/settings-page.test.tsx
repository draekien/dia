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

const rowOf = (branch: string) => screen.getByText(branch).closest('li')

const trigger = (branch: string) => screen.queryByRole('button', { name: `Actions for ${branch}` })

const openActions = async (branch: string) => {
  const button = trigger(branch)
  if (button === null) throw new Error(`No actions for ${branch}`)
  fireEvent.click(button)
  return screen.findAllByRole('menuitem')
}

const actionsOf = async (branch: string) => {
  if (trigger(branch) === null) return []
  const items = (await openActions(branch)).map((item) => item.textContent)
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  await waitFor(() => expect(screen.queryAllByRole('menuitem')).toEqual([]))
  return items
}

const choose = async (branch: string, action: string) => {
  const items = await openActions(branch)
  const item = items.find((candidate) => candidate.textContent === action)
  if (item === undefined) throw new Error(`No ${action} for ${branch}`)
  fireEvent.click(item)
}

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

    expect(rowOf('dia/live')?.textContent).toBe('dia/liveTab · diaIn use')
    expect(rowOf('dia/dirty')?.textContent).toBe(
      'dia/dirtyIssue · Fix loginNeeds decision1 changed file'
    )
  })

  it('offers Keep and Discard for NeedsDecision, only Discard for Kept, and no action menu otherwise', async () => {
    installHost([
      entry('a', 'l', NeedsDecision.make({ changedFiles: 2 })),
      entry('b', 'l', Kept.make({ changedFiles: 2 })),
      entry('c', 'l', Active.make({})),
      entry('d', 'l', Removed.make({}))
    ])

    await renderPage()

    const offered = []
    for (const branch of ['dia/a', 'dia/b', 'dia/c', 'dia/d']) offered.push(await actionsOf(branch))

    expect(offered).toEqual([['Keep', 'Remove'], ['Remove'], [], []])
  })

  it('sends DiscardWorktree with the worktree path', async () => {
    const host = installHost([entry('a', 'l', Kept.make({ changedFiles: 2 }))])
    await renderPage()

    await choose('dia/a', 'Remove')

    await waitFor(() =>
      expect(host.call.mock.calls).toEqual([['worktrees', 'DiscardWorktree', { path: '/trees/a' }]])
    )
  })

  it('sends KeepWorktree with the worktree path', async () => {
    const host = installHost([entry('a', 'l', NeedsDecision.make({ changedFiles: 2 }))])
    await renderPage()

    await choose('dia/a', 'Keep')

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

    await choose('dia/a', 'Remove')
    await host.push([entry('a', 'l', Active.make({}))])

    expect(await screen.findByText('dia/a is now in use')).toBeTruthy()
    await waitFor(() => expect(trigger('dia/a')).toBeNull())
  })
})
