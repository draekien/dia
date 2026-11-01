// @vitest-environment jsdom
import {
  CopySetupStep,
  SessionSetupStep,
  type SetupFile,
  WorktreeSetupStep
} from '@shared/domain/tab-setup'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { showsSetup, TabSetupSteps } from './tab-setup-steps'

afterEach(cleanup)

const rows = (): ReadonlyArray<string> =>
  Array.from(screen.getByRole('list', { name: 'Tab setup' }).children).map(
    (row) => row.textContent ?? ''
  )

const files = (count: number, failed: ReadonlyArray<number> = []): ReadonlyArray<SetupFile> =>
  Array.from({ length: count }, (_, index) =>
    failed.includes(index)
      ? { path: `config/file-${index}.json`, error: 'EBUSY: resource busy or locked' }
      : { path: `config/file-${index}.json` }
  )

describe('TabSetupSteps', () => {
  it('names each step with the created branch and its state', () => {
    render(
      <TabSetupSteps
        steps={[
          WorktreeSetupStep.make({ reattach: false, state: 'done', branch: 'dia/quiet-otter' }),
          SessionSetupStep.make({ state: 'running' })
        ]}
      />
    )

    expect(rows()).toEqual([
      'Create worktreedia/quiet-otterdone',
      'Start Claude Code sessionrunning'
    ])
  })

  it('names a resumed tab’s worktree step Reattach worktree', () => {
    render(<TabSetupSteps steps={[WorktreeSetupStep.make({ reattach: true, state: 'running' })]} />)

    expect(rows()).toEqual(['Reattach worktreerunning'])
  })

  it('lists every file of a copy of up to 5 files, with the reason a file was not copied', () => {
    render(
      <TabSetupSteps steps={[CopySetupStep.make({ state: 'warning', files: files(3, [1]) })]} />
    )

    expect(rows()).toEqual([
      'Copy 2 of 3 files.worktreeincludewarning' +
        'config/file-0.json' +
        'config/file-1.json — EBUSY: resource busy or locked' +
        'config/file-2.json'
    ])
  })

  it('lists only the files not copied when more than 5 files matched', () => {
    render(
      <TabSetupSteps steps={[CopySetupStep.make({ state: 'warning', files: files(6, [4]) })]} />
    )

    expect(rows()).toEqual([
      'Copy 5 of 6 files.worktreeincludewarningconfig/file-4.json — EBUSY: resource busy or locked'
    ])
  })

  it('lists no file when more than 5 files matched and all were copied', () => {
    render(<TabSetupSteps steps={[CopySetupStep.make({ state: 'done', files: files(6) })]} />)

    expect(rows()).toEqual(['Copy 6 files.worktreeincludedone'])
  })

  it('counts a single file in the singular', () => {
    render(<TabSetupSteps steps={[CopySetupStep.make({ state: 'pending', files: files(1) })]} />)

    expect(rows()[0]).toMatch(/^Copy 1 file\.worktreeinclude/)
  })

  it('shows why the files could not be matched', () => {
    render(
      <TabSetupSteps
        steps={[CopySetupStep.make({ state: 'warning', files: [], matchError: 'git not found' })]}
      />
    )

    expect(rows()).toEqual(['Copy files.worktreeincludewarninggit not found'])
  })

  it('shows the error of a failed step', () => {
    render(
      <TabSetupSteps
        steps={[
          SessionSetupStep.make({
            state: 'failed',
            error: "This tab's conversation could not be found."
          })
        ]}
      />
    )

    expect(rows()).toEqual([
      "Start Claude Code sessionfailedThis tab's conversation could not be found."
    ])
  })

  it('shows the duration of a step that took a second or more, and none for a quicker one', () => {
    render(
      <TabSetupSteps
        steps={[
          WorktreeSetupStep.make({ reattach: false, state: 'done', durationMs: 1800 }),
          SessionSetupStep.make({ state: 'done', durationMs: 999 })
        ]}
      />
    )

    expect(rows()).toEqual(['Create worktree1sdone', 'Start Claude Code sessiondone'])
  })
})

describe('showsSetup', () => {
  const done = WorktreeSetupStep.make({ reattach: false, state: 'done' })

  it('is false before any setup is reported', () => {
    expect(showsSetup(undefined)).toBe(false)
  })

  it('is true while a step is pending or running', () => {
    expect(showsSetup([done, SessionSetupStep.make({ state: 'pending' })])).toBe(true)
    expect(showsSetup([done, SessionSetupStep.make({ state: 'running' })])).toBe(true)
  })

  it('is false once every step is done or only warned', () => {
    expect(
      showsSetup([
        done,
        CopySetupStep.make({ state: 'warning', files: files(1, [0]) }),
        SessionSetupStep.make({ state: 'done' })
      ])
    ).toBe(false)
  })

  it('stays true after a step failed', () => {
    expect(showsSetup([done, SessionSetupStep.make({ state: 'failed', error: 'gone' })])).toBe(true)
  })
})
