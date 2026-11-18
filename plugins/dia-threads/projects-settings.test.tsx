// @vitest-environment jsdom

import type { ProjectEntry, Workspace } from '@shared/domain/project'
import { AgentName, ProjectId } from '@shared/domain/project'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectsSettings } from './projects-settings'

const state = vi.hoisted(() => ({
  workspace: undefined as Workspace | undefined,
  revealProject: (_directory: string) => {}
}))

vi.mock('@dia/renderer-plugin', async (importOriginal) => {
  const original = await importOriginal<typeof import('@dia/renderer-plugin')>()
  return {
    ...original,
    actions: {
      ...original.actions,
      revealProject: (directory: string) => state.revealProject(directory)
    },
    useWorkspace: () => state.workspace
  }
})

const entry = (n: number, displayName: string, withThread: boolean): ProjectEntry => ({
  project: {
    projectId: ProjectId.make(`00000000-0000-4000-8000-00000000000${n}`),
    directory: `F:/Dev/${displayName}`,
    directoryKey: `f:/dev/${displayName}`,
    displayName,
    isGitRepo: true
  },
  tabs: withThread
    ? [
        {
          name: AgentName.make('build'),
          config: {
            paneId: `00000000-0000-4000-8000-0000000001${n}0`,
            cwd: `F:/Dev/${displayName}`,
            model: 'm',
            backend: 'dia-claude-code',
            thinkingLevel: 'adaptive',
            permissionMode: 'default'
          },
          archived: false
        }
      ]
    : []
})

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  state.revealProject = vi.fn()
  state.workspace = {
    projects: [entry(1, 'dia', true), entry(2, 'skills', false)],
    visibleTab: null
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'dia')
})

describe('ProjectsSettings', () => {
  it('lists every project, including one with no open thread, with its directory', () => {
    render(<ProjectsSettings />)

    expect(
      [screen.getByText('dia'), screen.getByText('skills'), screen.getByText('F:/Dev/skills')].map(
        (node) => node !== null
      )
    ).toEqual([true, true, true])
  })

  it('renders nothing while the workspace has not loaded', () => {
    state.workspace = undefined

    const { container } = render(<ProjectsSettings />)

    expect(container.textContent).toBe('')
  })

  it('opens the removal dialog for the project whose menu was used', async () => {
    render(<ProjectsSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'Actions for skills' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove project' }))

    expect(screen.getByRole('dialog').textContent).toContain('skills')
  })

  it('reveals the project directory from the menu', async () => {
    render(<ProjectsSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'Actions for skills' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reveal in Explorer' }))

    expect(vi.mocked(state.revealProject).mock.calls).toEqual([['F:/Dev/skills']])
  })

  it('offers Add project when there is no project, and shows a refusal under it', async () => {
    state.workspace = { projects: [], visibleTab: null }
    Object.assign(window, {
      dia: {
        pickDirectory: vi.fn(async () => 'F:/Dev/dia'),
        registerProject: vi.fn(async () => ({ _tag: 'ProjectAlreadyRegisteredError' }))
      }
    })

    render(<ProjectsSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))

    expect(screen.getByText('No projects')).toBeTruthy()
    expect((await screen.findByText('dia already has a project for that directory.')).tagName).toBe(
      'P'
    )
  })
})
