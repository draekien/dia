// @vitest-environment jsdom
import type { MetaRepoPushResult, MetaRepoStateResult } from '@shared/domain/meta-repo'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MetaRepoSettings } from './meta-repo-settings'

const WITH_REMOTE: MetaRepoStateResult = {
  _tag: 'MetaRepoState',
  remoteUrl: 'git@github.com:me/meta.git',
  branch: 'main'
}
const NO_REMOTE: MetaRepoStateResult = { _tag: 'MetaRepoState', remoteUrl: null, branch: 'main' }
const COMMIT = '0123456789abcdef0123456789abcdef01234567'

const installBridge = (bridge: {
  readonly state: MetaRepoStateResult
  readonly setRemote?: (url: string) => Promise<MetaRepoStateResult>
  readonly push?: () => Promise<MetaRepoPushResult>
}) => {
  const setRemote = vi.fn(bridge.setRemote ?? (async () => bridge.state))
  const push = vi.fn(
    bridge.push ?? (async () => ({ _tag: 'MetaRepoFailed', message: '' }) as const)
  )
  Object.assign(window, {
    dia: { metaRepo: { getState: async () => bridge.state, setRemote, push } }
  })
  return { setRemote, push }
}

const renderPage = async () => {
  render(<MetaRepoSettings />)
  await act(async () => {})
}

const pushButton = () => screen.getByRole('button', { name: 'Push' })

afterEach(cleanup)

describe('MetaRepoSettings', () => {
  it('shows the remote and branch and offers to change the remote', async () => {
    installBridge({ state: WITH_REMOTE })

    await renderPage()

    expect(screen.getByText('git@github.com:me/meta.git')).toBeTruthy()
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Change remote' })).toBeTruthy()
  })

  it('keeps Push disabled until a remote is set', async () => {
    installBridge({ state: NO_REMOTE })

    await renderPage()

    expect((pushButton() as HTMLButtonElement).disabled).toBe(true)
  })

  it('sets the remote to the typed URL and shows the new state', async () => {
    const { setRemote } = installBridge({ state: NO_REMOTE, setRemote: async () => WITH_REMOTE })
    await renderPage()

    fireEvent.change(screen.getByRole('textbox', { name: 'Remote URL' }), {
      target: { value: 'git@github.com:me/meta.git' }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add remote' }))
    })

    expect(setRemote.mock.calls).toEqual([['git@github.com:me/meta.git']])
    expect(screen.getByText('git@github.com:me/meta.git')).toBeTruthy()
    expect((pushButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows why a remote was not set next to the field', async () => {
    installBridge({
      state: NO_REMOTE,
      setRemote: async () => ({ _tag: 'MetaRepoFailed', message: 'Enter a remote URL.' })
    })
    await renderPage()

    const field = screen.getByRole('textbox', { name: 'Remote URL' })
    fireEvent.change(field, { target: { value: '-x' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add remote' }))
    })

    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Enter a remote URL.')).toBeTruthy()
  })

  it('lists each finding of a refused push by description, location and short commit', async () => {
    installBridge({
      state: WITH_REMOTE,
      push: async () => ({
        _tag: 'MetaRepoPushRefused',
        findings: [
          {
            rule: 'github-token',
            description: 'GitHub token',
            commit: COMMIT,
            file: 'instructions.md',
            line: 4
          },
          { rule: 'jwt', description: 'JSON Web Token', commit: COMMIT, file: null, line: 3 }
        ]
      })
    })
    await renderPage()

    await act(async () => {
      fireEvent.click(pushButton())
    })

    expect(screen.getByText(/Push refused\. dia found 2 possible secrets/)).toBeTruthy()
    const rows = screen.getByRole('list', { name: 'Findings' }).querySelectorAll('li')
    expect(Array.from(rows, (row) => row.textContent)).toEqual([
      'GitHub token0123456instructions.md:4',
      'JSON Web Token0123456commit message, line 3'
    ])
  })

  it('reports a pushed branch with its commit count and remote', async () => {
    installBridge({
      state: WITH_REMOTE,
      push: async () => ({
        _tag: 'MetaRepoPushed',
        branch: 'main',
        remoteUrl: 'git@github.com:me/meta.git',
        commitCount: 1
      })
    })
    await renderPage()

    await act(async () => {
      fireEvent.click(pushButton())
    })

    expect(screen.getByText(/Pushed 1 commit of/).textContent).toBe(
      'Pushed 1 commit of main to git@github.com:me/meta.git.'
    )
  })

  it('shows the message of a failed push', async () => {
    installBridge({
      state: WITH_REMOTE,
      push: async () => ({ _tag: 'MetaRepoFailed', message: 'git push failed: rejected' })
    })
    await renderPage()

    await act(async () => {
      fireEvent.click(pushButton())
    })

    expect(screen.getByText('git push failed: rejected')).toBeTruthy()
  })

  it('shows why the meta repo is unavailable and no controls', async () => {
    installBridge({ state: { _tag: 'MetaRepoFailed', message: 'The meta plugin is not loaded.' } })

    await renderPage()

    expect(screen.getByText('The meta plugin is not loaded.')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
