// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalDialog, makeApprovalsAtom, sourceLine } from './approval-dialog'
import { OutsideSource, PendingApproval, RunSource } from './calls'

const ctx = { name: 'dia-tools' }

const encodeList = Schema.encodeSync(Schema.toCodecJson(Schema.Array(PendingApproval)))

const pending = (id: string, title: string): PendingApproval => ({
  id,
  source: RunSource.make({ project: 'F:/Dev/dia', labels: ['assistant'] }),
  request: { title, before: '{ "allow": [] }', after: '{ "allow": ["Bash"] }' }
})

const installHost = (list: ReadonlyArray<PendingApproval>) => {
  const watchers = new Set<(value: unknown) => void>()
  const call = vi.fn(async () => ({ _tag: 'Success', value: null }))
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
    push: (next: ReadonlyArray<PendingApproval>) =>
      act(() => {
        for (const watcher of watchers) watcher(encodeList(next))
      })
  }
}

const renderDialog = async () => {
  render(<ApprovalDialog ctx={ctx} approvalsAtom={makeApprovalsAtom(ctx)} />)
  return screen.findByRole('alertdialog')
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('ApprovalDialog', () => {
  it('shows the oldest request with its source, its before and after text, and the queue', async () => {
    installHost([pending('a', 'Change the Builder permissions'), pending('b', 'Second')])

    const dialog = await renderDialog()

    expect({
      title: screen.getByRole('heading').textContent,
      text: dialog.textContent
    }).toEqual({
      title: 'Change the Builder permissions',
      text: expect.stringContaining(
        'From a run in dia (assistant)Before{ "allow": [] }After{ "allow": ["Bash"] }1 more waiting'
      )
    })
  })

  it.each([
    ['Approve', 'approved'],
    ['Decline', 'declined']
  ])('sends %s as %s for the shown request', async (button, answer) => {
    const host = installHost([pending('a', 'Change it')])
    await renderDialog()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: button }))
    })

    expect(host.call.mock.calls).toEqual([['dia-tools', 'AnswerApproval', { id: 'a', answer }]])
  })

  it('stays open when Escape is pressed', async () => {
    installHost([pending('a', 'Change it')])
    const dialog = await renderDialog()

    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(screen.queryByRole('alertdialog')).not.toBeNull()
  })

  it('closes when no request is pending any more', async () => {
    const host = installHost([pending('a', 'Change it')])
    await renderDialog()

    await host.push([])

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('shows (empty) for an empty before text', async () => {
    installHost([
      { ...pending('a', 'Add it'), request: { title: 'Add it', before: '', after: 'x' } }
    ])

    const dialog = await renderDialog()

    expect(dialog.textContent).toContain('Before(empty)After')
  })
})

describe('sourceLine', () => {
  it('names an agent outside dia', () => {
    expect(sourceLine(OutsideSource.make({}))).toBe('From an agent outside dia')
  })

  it('names the last folder of a Windows project path and omits empty labels', () => {
    expect(sourceLine(RunSource.make({ project: 'C:\\work\\dia\\', labels: [] }))).toBe(
      'From a run in dia'
    )
  })

  it('says only "From a run" when the project is unknown, followed by the labels', () => {
    expect(sourceLine(RunSource.make({ project: null, labels: ['issue', 'org'] }))).toBe(
      'From a run (issue, org)'
    )
  })
})
