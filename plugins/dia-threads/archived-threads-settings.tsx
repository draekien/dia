import {
  actions,
  Button,
  closeSettings,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Empty,
  EmptyHeader,
  EmptyTitle,
  List,
  ListRow,
  ListRowAction,
  ListRowDescription,
  ListRowLink,
  ListRowName,
  ListRowSubject,
  SettingsSectionHeading,
  toast,
  userProjects,
  useWorkspace
} from '@dia/renderer-plugin'
import type { PaneId } from '@shared/domain/pane'
import type { ProjectEntry, Tab } from '@shared/domain/project'
import { Effect } from 'effect'
import { EllipsisIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { RETIREMENT_COPY, useRetirement } from './background-retirement'
import { RetireThreadDialog } from './retire-thread-dialog'

const unarchive = (tab: Tab): Promise<void> => {
  Effect.runFork(Effect.logDebug('Unarchiving thread from Settings', { paneId: tab.config.paneId }))
  return actions.unarchiveTab(tab.config.paneId).then(
    (reason) => {
      if (reason !== null) {
        toast.add({ title: `Could not unarchive ${tab.name}`, description: reason, type: 'error' })
      }
    },
    () => {
      toast.add({
        title: `Could not unarchive ${tab.name}`,
        description: "The connection to dia's background process was lost.",
        type: 'error'
      })
    }
  )
}

const show = (paneId: PaneId): void => {
  Effect.runFork(Effect.logDebug('Showing archived thread from Settings', { paneId }))
  closeSettings()
  actions.selectTab(paneId)
}

const archivedTabs = (entry: ProjectEntry): ReadonlyArray<Tab> =>
  entry.tabs.filter((tab) => tab.archived && tab.owner === undefined)

function ArchivedRow({
  tab,
  onDelete
}: {
  readonly tab: Tab
  readonly onDelete: (trigger: HTMLElement | null) => void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const deleting = useRetirement(tab.config.paneId) === 'delete'
  return (
    <ListRow value={tab.config.paneId}>
      <ListRowLink
        render={
          <button
            type="button"
            aria-disabled={deleting || undefined}
            onClick={() => {
              if (!deleting) show(tab.config.paneId)
            }}
          />
        }
      >
        <ListRowSubject>
          <ListRowName className={deleting ? 'text-ink-muted' : undefined}>{tab.name}</ListRowName>
          {deleting && <ListRowDescription>{RETIREMENT_COPY.delete.running}</ListRowDescription>}
        </ListRowSubject>
      </ListRowLink>
      <ListRowAction hidden={deleting}>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                ref={trigger}
                size="icon-sm"
                variant="ghost"
                aria-label={`Actions for ${tab.name}`}
              />
            }
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => void unarchive(tab)}>Unarchive</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(trigger.current)}>
                Delete…
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </ListRowAction>
    </ListRow>
  )
}

/**
 * The Archived threads page of the Settings dialog: every archived thread, grouped under its
 * project in the user's project order and in creation order inside a project. Clicking a thread
 * closes Settings and shows it. A thread's menu unarchives it, showing a toast when its working
 * directory cannot be restored, or deletes it after {@link RetireThreadDialog} confirms; while the
 * delete runs, the row is muted, reads `Deleting…`, does not open and has no menu. Renders
 * nothing until the workspace has loaded. Render it inside a scrolling container.
 */
export function ArchivedThreadsSettings() {
  const workspace = useWorkspace()
  const [deleting, setDeleting] = useState<{
    readonly paneId: PaneId
    readonly trigger: HTMLElement | null
  } | null>(null)
  if (workspace === undefined) return null
  const groups = userProjects(workspace)
    .map((entry) => ({ project: entry.project, tabs: archivedTabs(entry) }))
    .filter((group) => group.tabs.length > 0)
  const deletingTab = groups
    .flatMap((group) => group.tabs)
    .find((tab) => tab.config.paneId === deleting?.paneId)
  const remove = (paneId: PaneId, trigger: HTMLElement | null) => {
    Effect.runFork(
      Effect.logDebug('Confirming deletion of an archived thread from Settings', { paneId })
    )
    setDeleting({ paneId, trigger })
  }
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6">
      {groups.length === 0 ? (
        <>
          <SettingsSectionHeading id="archived-heading">Archived threads</SettingsSectionHeading>
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No archived threads</EmptyTitle>
            </EmptyHeader>
          </Empty>
        </>
      ) : (
        groups.map(({ project, tabs }) => (
          <section
            key={project.projectId}
            className="flex flex-col gap-3"
            aria-labelledby={`archived-${project.projectId}`}
          >
            <SettingsSectionHeading id={`archived-${project.projectId}`}>
              {project.displayName}
            </SettingsSectionHeading>
            <List aria-labelledby={`archived-${project.projectId}`}>
              {tabs.map((tab) => (
                <ArchivedRow
                  key={tab.config.paneId}
                  tab={tab}
                  onDelete={(trigger) => remove(tab.config.paneId, trigger)}
                />
              ))}
            </List>
          </section>
        ))
      )}
      {deletingTab === undefined ? null : (
        <RetireThreadDialog
          key={deletingTab.config.paneId}
          tab={deletingTab}
          retirement="delete"
          onClose={() => setDeleting(null)}
          returnFocus={deleting?.trigger}
        />
      )}
    </div>
  )
}
