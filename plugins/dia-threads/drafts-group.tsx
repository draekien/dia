import {
  actions,
  type Draft,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  type ThreadTarget,
  useDrafts,
  useList,
  useView,
  useWorkspace
} from '@dia/renderer-plugin'
import { ThreadTargetsSlot, targetEntryOf } from '@dia-plugin/dia-chat/slots'
import { userProjects } from '@shared/domain/workspace'
import { PenLineIcon, XIcon } from 'lucide-react'

/** The text a draft row shows: the first non-blank line of `text`, or "Empty" when there is none. */
export const draftTitle = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '') ?? 'Empty'

function useTargetName(): (target: ThreadTarget | null) => string {
  const workspace = useWorkspace()
  const entries = useList(ThreadTargetsSlot)
  const projects = workspace === undefined ? [] : userProjects(workspace)
  return (target) => {
    if (target === null) return 'No project'
    if (target._tag === 'ProjectTarget')
      return (
        projects.find((entry) => entry.project.projectId === target.projectId)?.project
          .displayName ?? 'Removed project'
      )
    return targetEntryOf(entries, target)?.label ?? target.id
  }
}

function DraftRow({
  draft,
  targetName,
  active
}: {
  readonly draft: Draft
  readonly targetName: string
  readonly active: boolean
}) {
  const title = draftTitle(draft.text)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        aria-current={active ? 'page' : undefined}
        tooltip={`${title} · ${targetName}`}
        onClick={() => actions.openDraft(draft.draftId)}
      >
        <PenLineIcon />
        <span className={draft.text.trim() === '' ? 'truncate text-ink-muted' : 'truncate'}>
          {title}
        </span>
        <span className="ml-auto shrink-0 text-ink-muted text-xs group-data-[collapsible=icon]:hidden">
          {targetName}
        </span>
      </SidebarMenuButton>
      <SidebarMenuAction
        showOnHover
        aria-label={`Discard draft ${title}`}
        onClick={() => actions.discardDraft(draft.draftId)}
      >
        <XIcon />
      </SidebarMenuAction>
    </SidebarMenuItem>
  )
}

/**
 * The sidebar's Drafts section: one row per unsent new thread, oldest first, naming its first line
 * and its target. A row opens its draft's new-thread page; its hover action discards the draft.
 * Renders nothing while there are no drafts.
 */
export function DraftsGroup() {
  const drafts = useDrafts()
  const view = useView()
  const targetName = useTargetName()
  if (drafts.length === 0) return null
  return (
    <SidebarGroup className="pb-0">
      <SidebarGroupLabel>Drafts</SidebarGroupLabel>
      <SidebarMenu>
        {drafts.map((draft) => (
          <DraftRow
            key={draft.draftId}
            draft={draft}
            targetName={targetName(draft.target)}
            active={view?._tag === 'NewThreadView' && view.draftId === draft.draftId}
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
