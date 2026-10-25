import { Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import type { PaneId } from './pane'
import { SessionId } from './pane'
import { AgentName, EMPTY_WORKSPACE, type Project, ProjectId, type Tab, Workspace } from './project'
import {
  addProject,
  addTab,
  moveProject,
  moveVisibleTabOff,
  recordSession,
  removeProject,
  renameTab,
  selectTab,
  tabOf,
  updateTabConfig,
  withDefaultVisibleTab
} from './workspace'

const projectId = (n: number) => ProjectId.make(`00000000-0000-4000-8000-00000000000${n}`)
const paneId = (n: number): PaneId => `10000000-0000-4000-8000-00000000000${n}`

const project = (n: number): Project => ({
  projectId: projectId(n),
  directory: `F:\\Dev\\repo${n}`,
  directoryKey: `f:\\dev\\repo${n}`,
  displayName: `repo${n}`,
  isGitRepo: true
})

const tab = (n: number, archived = false): Tab => ({
  name: AgentName.make(`agent-${n}`),
  config: {
    paneId: paneId(n),
    cwd: 'F:\\Dev',
    model: 'claude-sonnet-5-5',
    thinkingLevel: 'adaptive',
    permissionMode: 'default'
  },
  archived
})

const workspaceOf = (
  entries: ReadonlyArray<readonly [number, ReadonlyArray<Tab>]>,
  visible: PaneId | null = null
): Workspace => ({
  projects: entries.map(([n, tabs]) => ({ project: project(n), tabs })),
  visibleTab: visible
})

const ok = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`expected success, got ${String(result.failure)}`)
  return result.success
}

const failureTag = <A, E extends { readonly _tag: string }>(result: Result.Result<A, E>) =>
  Result.isFailure(result) ? result.failure._tag : 'success'

const order = (workspace: Workspace) => workspace.projects.map((entry) => entry.project.projectId)

describe('Workspace schema', () => {
  it('round-trips projects, tabs, order and the visible tab through encode and decode', () => {
    const workspace = workspaceOf(
      [
        [2, [tab(1)]],
        [1, [tab(2), tab(3, true)]]
      ],
      paneId(2)
    )

    const decoded = Schema.decodeUnknownSync(Workspace)(Schema.encodeSync(Workspace)(workspace))

    expect(decoded).toEqual(workspace)
  })

  it('rejects two projects with the same directory key', () => {
    const encoded = Schema.encodeSync(Workspace)(
      workspaceOf([
        [1, []],
        [2, []]
      ])
    )
    const second = encoded.projects[1]
    const clash = {
      ...encoded,
      projects: [
        encoded.projects[0],
        { ...second, project: { ...second.project, directoryKey: project(1).directoryKey } }
      ]
    }

    expect(Result.isFailure(Schema.decodeUnknownResult(Workspace)(clash))).toBe(true)
  })

  it('rejects two tabs with the same pane id', () => {
    const encoded = Schema.encodeSync(Workspace)(
      workspaceOf([
        [1, [tab(1)]],
        [2, [tab(2)]]
      ])
    )
    const clash = {
      ...encoded,
      projects: [encoded.projects[0], { ...encoded.projects[1], tabs: encoded.projects[0].tabs }]
    }

    expect(Result.isFailure(Schema.decodeUnknownResult(Workspace)(clash))).toBe(true)
  })

  it('rejects a visible tab that no tab has', () => {
    const encoded = Schema.encodeSync(Workspace)(workspaceOf([[1, [tab(1)]]]))

    expect(
      Result.isFailure(Schema.decodeUnknownResult(Workspace)({ ...encoded, visibleTab: paneId(9) }))
    ).toBe(true)
  })

  it('rejects an archived visible tab', () => {
    const encoded = Schema.encodeSync(Workspace)(workspaceOf([[1, [tab(1, true)]]]))

    expect(
      Result.isFailure(Schema.decodeUnknownResult(Workspace)({ ...encoded, visibleTab: paneId(1) }))
    ).toBe(true)
  })
})

describe('AgentName', () => {
  it.each([
    ['an empty name', ''],
    ['a name with a leading space', ' otter'],
    ['a name of 65 characters', 'a'.repeat(65)]
  ])('rejects %s', (_, input) => {
    expect(Result.isFailure(Schema.decodeUnknownResult(AgentName)(input))).toBe(true)
  })

  it('accepts a name of 64 characters', () => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(AgentName)('a'.repeat(64)))).toBe(true)
  })
})

describe('addProject', () => {
  it('appends a project to the end of the order', () => {
    const result = ok(addProject(workspaceOf([[1, []]]), project(2)))

    expect(order(result)).toEqual([projectId(1), projectId(2)])
  })

  it('refuses a directory another project already registered', () => {
    const other = { ...project(2), directoryKey: project(1).directoryKey }

    expect(failureTag(addProject(workspaceOf([[1, []]]), other))).toBe(
      'ProjectAlreadyRegisteredError'
    )
  })

  it('returns the workspace unchanged when the same project is registered again', () => {
    const workspace = workspaceOf([[1, [tab(1)]]])

    expect(ok(addProject(workspace, project(1)))).toBe(workspace)
  })
})

describe('moveProject', () => {
  const three = workspaceOf([
    [1, []],
    [2, []],
    [3, []]
  ])

  it('moves a project forward to the given index', () => {
    expect(order(ok(moveProject(three, projectId(1), 2)))).toEqual([
      projectId(2),
      projectId(3),
      projectId(1)
    ])
  })

  it('moves a project back to the given index', () => {
    expect(order(ok(moveProject(three, projectId(3), 0)))).toEqual([
      projectId(3),
      projectId(1),
      projectId(2)
    ])
  })

  it('moves a project to the last place when the index is past the end', () => {
    expect(order(ok(moveProject(three, projectId(1), 7)))).toEqual([
      projectId(2),
      projectId(3),
      projectId(1)
    ])
  })

  it('moves a project to the first place when the index is negative', () => {
    expect(order(ok(moveProject(three, projectId(2), -1)))).toEqual([
      projectId(2),
      projectId(1),
      projectId(3)
    ])
  })

  it('fails for a project that is not registered', () => {
    expect(failureTag(moveProject(three, projectId(9), 0))).toBe('ProjectNotFoundError')
  })
})

describe('removeProject', () => {
  it('drops the project and its tabs', () => {
    const result = ok(
      removeProject(
        workspaceOf(
          [
            [1, [tab(1)]],
            [2, [tab(2)]]
          ],
          paneId(2)
        ),
        projectId(1)
      )
    )

    expect(result).toEqual(workspaceOf([[2, [tab(2)]]], paneId(2)))
  })

  it('shows the first non-archived tab of the next project when the removed project held the visible tab', () => {
    const workspace = workspaceOf(
      [
        [1, [tab(1)]],
        [2, [tab(2, true), tab(3)]],
        [3, [tab(4)]]
      ],
      paneId(1)
    )

    expect(ok(removeProject(workspace, projectId(1))).visibleTab).toEqual(paneId(3))
  })

  it('shows the first tab of the previous project when the next project has no tab to show', () => {
    const workspace = workspaceOf(
      [
        [1, [tab(1)]],
        [2, [tab(2)]],
        [3, [tab(3, true)]]
      ],
      paneId(2)
    )

    expect(ok(removeProject(workspace, projectId(2))).visibleTab).toEqual(paneId(1))
  })

  it('shows no tab when no neighbouring project has a tab to show', () => {
    const workspace = workspaceOf([[1, [tab(1)]]], paneId(1))

    expect(ok(removeProject(workspace, projectId(1))).visibleTab).toEqual(null)
  })

  it('keeps the visible tab when it is in another project', () => {
    const workspace = workspaceOf(
      [
        [1, [tab(1)]],
        [2, [tab(2)]],
        [3, [tab(3)]]
      ],
      paneId(3)
    )

    expect(ok(removeProject(workspace, projectId(1))).visibleTab).toEqual(paneId(3))
  })

  it('fails for a project that is not registered', () => {
    expect(failureTag(removeProject(EMPTY_WORKSPACE, projectId(1)))).toBe('ProjectNotFoundError')
  })
})

describe('moveVisibleTabOff', () => {
  it('keeps the project while moving the visible tab off it', () => {
    const workspace = workspaceOf(
      [
        [1, [tab(1)]],
        [2, [tab(2)]]
      ],
      paneId(1)
    )

    expect(ok(moveVisibleTabOff(workspace, projectId(1)))).toEqual(
      workspaceOf(
        [
          [1, [tab(1)]],
          [2, [tab(2)]]
        ],
        paneId(2)
      )
    )
  })
})

describe('addTab', () => {
  it('appends the tab to its project and makes it visible', () => {
    const result = ok(addTab(workspaceOf([[1, [tab(1)]]], paneId(1)), projectId(1), tab(2)))

    expect(result).toEqual(workspaceOf([[1, [tab(1), tab(2)]]], paneId(2)))
  })

  it('adds nothing when the pane id already has a tab, and makes that tab visible', () => {
    const result = ok(addTab(workspaceOf([[1, [tab(1), tab(2)]]], paneId(1)), projectId(1), tab(2)))

    expect(result).toEqual(workspaceOf([[1, [tab(1), tab(2)]]], paneId(2)))
  })

  it('fails for a project that is not registered', () => {
    expect(failureTag(addTab(EMPTY_WORKSPACE, projectId(1), tab(1)))).toBe('ProjectNotFoundError')
  })
})

describe('selectTab', () => {
  const workspace = workspaceOf([[1, [tab(1), tab(2, true)]]], paneId(1))

  it('shows no tab when given none', () => {
    expect(ok(selectTab(workspace, null)).visibleTab).toEqual(null)
  })

  it('fails for an archived tab', () => {
    expect(failureTag(selectTab(workspace, paneId(2)))).toBe('TabNotFoundError')
  })

  it('fails for a pane id no tab has', () => {
    expect(failureTag(selectTab(workspace, paneId(9)))).toBe('TabNotFoundError')
  })
})

describe('tab updates', () => {
  const workspace = workspaceOf([[1, [tab(1), tab(2)]]])

  it('renames only the named tab', () => {
    const result = ok(renameTab(workspace, paneId(2), AgentName.make('heron')))

    expect(result.projects[0].tabs.map((t) => t.name)).toEqual(['agent-1', 'heron'])
  })

  it('records the session id on the named tab', () => {
    const result = ok(recordSession(workspace, paneId(1), SessionId.make('session-1')))

    expect(result.projects[0].tabs[0].sessionId).toBe('session-1')
  })

  it('updates config fields but never the pane id', () => {
    const result = ok(
      updateTabConfig(workspace, paneId(1), { thinkingLevel: 'high', paneId: paneId(5) } as never)
    )

    expect(result.projects[0].tabs[0].config).toMatchObject({
      paneId: paneId(1),
      thinkingLevel: 'high'
    })
  })

  it('fails to rename a pane id no tab has', () => {
    expect(failureTag(renameTab(workspace, paneId(9), AgentName.make('heron')))).toBe(
      'TabNotFoundError'
    )
  })

  it('finds the tab and the project that holds it', () => {
    expect(ok(tabOf(workspace, paneId(2)))).toEqual({ project: project(1), tab: tab(2) })
  })
})

describe('withDefaultVisibleTab', () => {
  it('shows the first non-archived tab when no tab is visible', () => {
    const workspace = workspaceOf([
      [1, [tab(1, true)]],
      [2, [tab(2)]]
    ])

    expect(withDefaultVisibleTab(workspace).visibleTab).toEqual(paneId(2))
  })

  it('keeps an already visible tab', () => {
    const workspace = workspaceOf([[1, [tab(1), tab(2)]]], paneId(2))

    expect(withDefaultVisibleTab(workspace)).toBe(workspace)
  })
})
