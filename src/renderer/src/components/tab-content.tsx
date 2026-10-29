import { usePrevious } from '@renderer/hooks/use-previous'
import type { Project, Workspace } from '@shared/domain/project'
import { tabOf } from '@shared/domain/workspace'
import { Result } from 'effect'
import { FolderPlusIcon, PlusIcon } from 'lucide-react'
import { newAgent, registerProject } from '../lib/actions'
import { useView, useWorkspace } from '../plugin-api'
import Pane from './pane'
import PaneCreationForm from './pane-creation-form'
import { StartupSkeleton } from './startup-skeleton'
import { Button } from './ui/button'
import { WindowStatus } from './window-status'

function FirstRun() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-start gap-3">
        <h1 className="text-xl font-semibold text-ink">Add a project</h1>
        <p className="text-sm text-ink-muted">
          A project is any directory on this machine. Agents run inside it, and agents in a git repo
          can each get their own worktree.
        </p>
        <Button onClick={() => void registerProject()}>
          <FolderPlusIcon data-icon="inline-start" />
          Add project…
        </Button>
      </div>
    </div>
  )
}

function EmptyProject({ project }: { readonly project: Project }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-start gap-3">
        <h1 className="text-base font-semibold text-ink">No agent is open</h1>
        <p className="text-sm text-ink-muted">
          Pick an agent in the sidebar, or start one in {project.displayName}.
        </p>
        <Button onClick={() => newAgent(project.projectId)}>
          <PlusIcon data-icon="inline-start" />
          New agent
        </Button>
      </div>
    </div>
  )
}

function VisibleTab({
  workspace,
  paneId,
  focusComposer
}: {
  readonly workspace: Workspace
  readonly paneId: string
  readonly focusComposer: boolean
}) {
  const found = tabOf(workspace, paneId)
  if (Result.isFailure(found)) return null
  const { config } = found.success.tab
  return (
    <Pane
      key={config.paneId}
      paneId={config.paneId}
      cwd={config.cwd}
      model={config.model}
      thinkingLevel={config.thinkingLevel}
      permissionMode={config.permissionMode}
      focusComposer={focusComposer}
    />
  )
}

/**
 * The kernel's content area, shown in the `main` slot unless a plugin fills it. Renders by the
 * current view: the visible tab, the New agent form, the first-run screen, or
 * the prompt to start an agent; the startup skeleton until the workspace loads.
 */
export function TabContent() {
  const view = useView()
  const workspace = useWorkspace()
  const previousView = usePrevious(view)
  const cameFromNewAgent = previousView?._tag === 'NewAgentView'
  if (view === undefined || workspace === undefined) return <StartupSkeleton />
  switch (view._tag) {
    case 'TabView':
      return (
        <VisibleTab workspace={workspace} paneId={view.paneId} focusComposer={cameFromNewAgent} />
      )
    case 'NewAgentView': {
      const entry = workspace.projects.find(
        (candidate) => candidate.project.projectId === view.projectId
      )
      return entry === undefined ? null : (
        <PaneCreationForm key={view.projectId} project={entry.project} />
      )
    }
    case 'FirstRunView':
      return <FirstRun />
    case 'EmptyProjectView':
      return <EmptyProject project={workspace.projects[0].project} />
  }
}

/**
 * Shown in place of the window body when no plugin fills the `root` slot. Keeps a drag row with
 * the window status so the window can still be moved and plugin loading stays visible.
 */
export function NoLayoutPlugin() {
  return (
    <div className="flex h-full flex-col">
      <div className="titlebar-drag flex h-8 shrink-0 items-center justify-end pr-(--titlebar-controls-inset)">
        <WindowStatus />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <p className="max-w-sm text-sm text-ink-muted">
          No layout plugin is loaded. Press Ctrl K, type "plug", and load the layout plugin from
          Settings › Plugins.
        </p>
      </div>
    </div>
  )
}
