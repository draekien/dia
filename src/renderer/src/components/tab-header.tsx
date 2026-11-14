import type { Project } from '@shared/domain/project'
import { tabOf } from '@shared/domain/workspace'
import { Result } from 'effect'
import { RulerIcon } from 'lucide-react'
import { useView, useWorkspace } from '../plugin-api'
import { BottomPanelToggle } from './bottom-panel'
import { RightPanelToggle } from './right-panel'
import { RailToggle } from './session-rail'
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
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon-xs" aria-label="Transcript width">
            <RulerIcon />
          </Button>
        }
      />
      <PopoverContent side="bottom" align="end" className="flex w-64 flex-col gap-2">
        <span className="text-xs font-medium text-ink">Transcript width</span>
        <TranscriptWidthToggle />
        <span className="text-xs text-ink-muted">Applies to every tab.</span>
      </PopoverContent>
    </Popover>
  )
}

function Crumbs({ project, page }: { readonly project?: Project; readonly page: string }) {
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {project !== undefined && (
          <>
            <BreadcrumbItem className="min-w-0">
              <span className="truncate">{project.displayName}</span>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </>
        )}
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
 * transcript width control for a tab, `project › label` with the same control for an attached
 * session, `project › New agent` for the New agent form, nothing for
 * the other views; the layout plugin draws a page's label) followed, for a tab, by the session rail
 * toggle, the bottom panel toggle and the right panel toggle, then {@link WindowStatus} at the right end. A plugin that
 * fills the slot owns the status items.
 */
export function TabHeader() {
  const view = useView()
  const workspace = useWorkspace()
  const found =
    view?._tag === 'TabView' && workspace !== undefined ? tabOf(workspace, view.paneId) : undefined
  const tab = found !== undefined && Result.isSuccess(found) ? found.success : undefined
  const showsChat = tab !== undefined
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
        {showsChat && <TranscriptWidthButton />}
        {showsChat && <RailToggle />}
        {showsChat && <BottomPanelToggle paneId={tab.tab.config.paneId} />}
        {showsChat && <RightPanelToggle paneId={tab.tab.config.paneId} />}
        <WindowStatus />
      </div>
    </div>
  )
}
