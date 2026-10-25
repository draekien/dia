import type { Project, Workspace } from '@shared/domain/project'
import { TRANSCRIPT_WIDTHS, type TranscriptWidth } from '@shared/domain/transcript-width'
import { tabOf } from '@shared/domain/workspace'
import { Result } from 'effect'
import { FolderPlusIcon, PlusIcon, RulerIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { newAgent, registerProject } from '../lib/actions'
import { MAIN_HEADER, Slot } from '../lib/slots'
import { useTranscriptWidth, useView, useWorkspace } from '../plugin-api'
import Pane from './pane'
import PaneCreationForm from './pane-creation-form'
import { StartupSkeleton } from './startup-skeleton'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

const WIDTH_LABELS: Record<TranscriptWidth, string> = {
  narrow: 'Narrow',
  default: 'Default',
  wide: 'Wide'
}

function TranscriptWidthButton() {
  const [width, setWidth] = useTranscriptWidth()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Transcript width">
          <RulerIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-64 flex-col gap-2">
        <span className="text-xs font-medium text-ink">Transcript width</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={width}
          onValueChange={(value: TranscriptWidth | '') => {
            if (value !== '') setWidth(value)
          }}
        >
          {TRANSCRIPT_WIDTHS.map((option) => (
            <ToggleGroupItem key={option} value={option} className="flex-1">
              {WIDTH_LABELS[option]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="text-xs text-ink-muted">Applies to every tab.</span>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The kernel's header above the visible tab: `project / agent`, the worktree branch when the tab
 * has one, and the transcript width control. Shown in the `main.header` slot unless a plugin
 * fills it.
 */
export function TabHeader() {
  const view = useView()
  const workspace = useWorkspace()
  if (view?._tag !== 'TabView' || workspace === undefined) return null
  const found = tabOf(workspace, view.paneId)
  if (Result.isFailure(found)) return null
  const { project, tab } = found.success
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 px-4">
      <h1 className="flex min-w-0 items-center gap-1.5 text-sm">
        <span className="truncate text-ink-muted">{project.displayName}</span>
        <span className="text-ink-muted" aria-hidden>
          /
        </span>
        <span className="truncate font-medium text-ink">{tab.name}</span>
      </h1>
      {tab.config.worktree !== undefined && (
        <span
          title={tab.config.worktree.path}
          className="truncate rounded-sm border border-border px-1.5 py-0.5 font-mono text-xs text-ink-muted"
        >
          {tab.config.worktree.branch}
        </span>
      )}
      <div className="ml-auto">
        <TranscriptWidthButton />
      </div>
    </div>
  )
}

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
    <div className="flex h-full min-h-0 flex-col">
      <Slot name={MAIN_HEADER} />
      <div className="min-h-0 flex-1">
        <Pane
          key={config.paneId}
          paneId={config.paneId}
          thinkingLevel={config.thinkingLevel}
          permissionMode={config.permissionMode}
          focusComposer={focusComposer}
        />
      </div>
    </div>
  )
}

/**
 * The kernel's content area, shown in the `main` slot unless a plugin fills it. Renders by the
 * current view: the visible tab under its header, the New agent form, the first-run screen, or
 * the prompt to start an agent; the startup skeleton until the workspace loads.
 */
export function TabContent() {
  const view = useView()
  const workspace = useWorkspace()
  const previousView = useRef(view)
  const cameFromNewAgent = previousView.current?._tag === 'NewAgentView'
  useEffect(() => {
    previousView.current = view
  }, [view])
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

/** Shown in place of the window body when no plugin fills the `root` slot. */
export function NoLayoutPlugin() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className="max-w-sm text-sm text-ink-muted">
        No layout plugin is loaded. Load the <span className="font-mono">layout</span> plugin from
        the command palette's Plugins page.
      </p>
    </div>
  )
}
