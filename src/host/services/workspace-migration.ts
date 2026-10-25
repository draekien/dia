import { randomUUID } from 'node:crypto'
import { generateAgentName } from '@shared/domain/agent-name'
import { PaneConfig, SessionId } from '@shared/domain/pane'
import {
  AgentName,
  type ProjectEntry,
  ProjectId,
  type Tab,
  type Workspace
} from '@shared/domain/project'
import { withDefaultVisibleTab } from '@shared/domain/workspace'
import { Effect, Option, Schema } from 'effect'
import { directoryKey, probeProject } from './project-directory'

const LegacyLeaf = Schema.Struct({
  _tag: Schema.Literal('Leaf'),
  paneId: Schema.String,
  status: Schema.Literals(['pending', 'ready'])
})

interface LegacySplit {
  readonly _tag: 'Split'
  readonly children: ReadonlyArray<LegacyNode>
}

type LegacyNode = typeof LegacyLeaf.Type | LegacySplit

const LegacyNode: Schema.Codec<LegacyNode> = Schema.Union([
  LegacyLeaf,
  Schema.Struct({
    _tag: Schema.Literal('Split'),
    children: Schema.Array(Schema.suspend((): Schema.Codec<LegacyNode> => LegacyNode))
  })
])

/**
 * The workspace file written before projects existed (version 1): a pane layout tree and each
 * pane's config and session id. Decode an unversioned `workspace.json` with it, then convert it
 * with {@link migrateLegacyWorkspace}.
 */
export const LegacyWorkspace = Schema.Struct({
  tree: LegacyNode,
  panes: Schema.Record(
    Schema.String,
    Schema.Struct({ config: PaneConfig, sessionId: Schema.optional(SessionId) })
  )
})
export type LegacyWorkspace = typeof LegacyWorkspace.Type

const readyLeavesInOrder = (node: LegacyNode): ReadonlyArray<string> =>
  node._tag === 'Leaf'
    ? node.status === 'ready'
      ? [node.paneId]
      : []
    : node.children.flatMap(readyLeavesInOrder)

const nameFromBranch = (branch: string | undefined): Option.Option<AgentName> =>
  branch?.startsWith('dia/') === true
    ? Schema.decodeUnknownOption(AgentName)(branch.slice('dia/'.length))
    : Option.none()

/**
 * Converts a version 1 workspace into projects and tabs. Each pane becomes a tab in the project
 * of its source directory (the worktree's source repo, else its working directory); projects are
 * ordered by their first pane in the layout tree and keep the first spelling of their directory.
 * A tab is named after its `dia/<slug>` worktree branch, else gets a generated name. Pending
 * panes are dropped, and the first tab is visible. A source directory that no longer exists still
 * becomes a project, with `isGitRepo: false`.
 */
export const migrateLegacyWorkspace = Effect.fn('migrateLegacyWorkspace')(function* (
  legacy: LegacyWorkspace
) {
  const treeOrder = readyLeavesInOrder(legacy.tree)
  const paneIds = [
    ...treeOrder,
    ...Object.keys(legacy.panes).filter((paneId) => !treeOrder.includes(paneId))
  ].filter((paneId) => legacy.panes[paneId] !== undefined)

  const groups = new Map<string, { directory: string; tabs: Array<Tab> }>()
  for (const paneId of paneIds) {
    const { config, sessionId } = legacy.panes[paneId]
    const directory = config.worktree?.sourceRepo ?? config.cwd
    const key = yield* directoryKey(directory)
    const name = yield* Option.match(nameFromBranch(config.worktree?.branch), {
      onNone: () => generateAgentName,
      onSome: Effect.succeed
    })
    const tab: Tab =
      sessionId === undefined
        ? { name, config, archived: false }
        : { name, config, sessionId, archived: false }
    const group = groups.get(key) ?? { directory, tabs: [] }
    group.tabs.push(tab)
    groups.set(key, group)
  }

  const projects: Array<ProjectEntry> = []
  for (const { directory, tabs } of groups.values()) {
    const project = yield* probeProject(ProjectId.make(randomUUID()), directory)
    projects.push({ project, tabs })
  }

  yield* Effect.logInfo('Migrated version 1 workspace', {
    panes: paneIds.length,
    projects: projects.length
  })
  const workspace: Workspace = { projects, visibleTab: null }
  return withDefaultVisibleTab(workspace)
})
