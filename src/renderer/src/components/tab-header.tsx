import type { Project } from '@shared/domain/project'
import { tabOf } from '@shared/domain/workspace'
import { Result } from 'effect'
import { RulerIcon } from 'lucide-react'
import { useView, useWorkspace } from '../plugin-api'
import { TranscriptWidthToggle } from './transcript-width-toggle'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from './ui/breadcrumb'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { WindowStatus } from './window-status'

function TranscriptWidthButton() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Transcript width">
          <RulerIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="flex w-64 flex-col gap-2">
        <span className="text-xs font-medium text-ink">Transcript width</span>
        <TranscriptWidthToggle />
        <span className="text-xs text-ink-muted">Applies to every tab.</span>
      </PopoverContent>
    </Popover>
  )
}

function Crumbs({ project, page }: { readonly project: Project; readonly page: string }) {
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="min-w-0">
          <span className="truncate">{project.displayName}</span>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="truncate font-medium">{page}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function WorktreeChip({ worktree }: { readonly worktree: { path: string; branch: string } }) {
  return (
    <span
      title={worktree.path}
      className="truncate rounded-sm border border-border px-1.5 py-0.5 font-mono text-xs text-ink-muted"
    >
      {worktree.branch}
    </span>
  )
}

/**
 * The kernel's content for the card header row, shown in the `main.header` slot unless a plugin
 * fills it. A breadcrumb for the current view (`project › agent` with the worktree branch and the
 * transcript width control for a tab, `project › New agent` for the New agent form, nothing for
 * the other views) followed by {@link WindowStatus} at the right end. A plugin that fills the
 * slot owns the status items.
 */
export function TabHeader() {
  const view = useView()
  const workspace = useWorkspace()
  const found =
    view?._tag === 'TabView' && workspace !== undefined ? tabOf(workspace, view.paneId) : undefined
  const tab = found !== undefined && Result.isSuccess(found) ? found.success : undefined
  const newAgentProject =
    view?._tag === 'NewAgentView'
      ? workspace?.projects.find((entry) => entry.project.projectId === view.projectId)?.project
      : undefined

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {tab !== undefined && <Crumbs project={tab.project} page={tab.tab.name} />}
      {tab?.tab.config.worktree !== undefined && (
        <WorktreeChip worktree={tab.tab.config.worktree} />
      )}
      {newAgentProject !== undefined && <Crumbs project={newAgentProject} page="New agent" />}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {tab !== undefined && <TranscriptWidthButton />}
        <WindowStatus />
      </div>
    </div>
  )
}
