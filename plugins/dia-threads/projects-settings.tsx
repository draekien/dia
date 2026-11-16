import {
  actions,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  List,
  ListRow,
  ListRowAction,
  ListRowDescription,
  ListRowLink,
  ListRowName,
  ListRowSubject,
  REGISTER_PROJECT_REFUSAL_TEXT,
  SettingsSectionHeading,
  userProjects,
  useWorkspace
} from '@dia/renderer-plugin'
import type { ProjectEntry, ProjectId } from '@shared/domain/project'
import { Effect } from 'effect'
import { EllipsisIcon, FolderPlusIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { RemoveProjectDialog } from './remove-project-dialog'

function NoProjects() {
  const [refusal, setRefusal] = useState<string | null>(null)
  const addProject = () =>
    void actions
      .registerProject()
      .then((result) =>
        setRefusal(result == null ? null : REGISTER_PROJECT_REFUSAL_TEXT[result._tag])
      )
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>No projects</EmptyTitle>
        <EmptyDescription>Add a directory to start threads in it.</EmptyDescription>
      </EmptyHeader>
      <Button size="sm" variant="outline" onClick={addProject}>
        <FolderPlusIcon data-icon="inline-start" />
        Add project
      </Button>
      {refusal === null ? null : <p className="text-sm text-error">{refusal}</p>}
    </Empty>
  )
}

function ProjectRow({
  entry,
  onRemove
}: {
  readonly entry: ProjectEntry
  readonly onRemove: (trigger: HTMLElement | null) => void
}) {
  const { project } = entry
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <ListRow value={project.projectId}>
      <ListRowLink render={<div />} title={project.directory}>
        <ListRowSubject>
          <ListRowName>{project.displayName}</ListRowName>
          <ListRowDescription className="font-mono text-xs">{project.directory}</ListRowDescription>
        </ListRowSubject>
      </ListRowLink>
      <ListRowAction>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                ref={trigger}
                size="icon-sm"
                variant="ghost"
                aria-label={`Actions for ${project.displayName}`}
              />
            }
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => void actions.revealProject(project.directory)}>
                Reveal in Explorer
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem variant="destructive" onClick={() => onRemove(trigger.current)}>
                Remove project
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </ListRowAction>
    </ListRow>
  )
}

/**
 * The Projects page of the Settings dialog: every project the user added, in the user's order, with
 * its name, directory and a menu to reveal it in the file manager or remove it. Remove project
 * opens {@link RemoveProjectDialog}. With no project it offers Add project. Renders nothing until the
 * workspace has loaded. Render it inside a scrolling container.
 */
export function ProjectsSettings() {
  const workspace = useWorkspace()
  const [removing, setRemoving] = useState<{
    readonly projectId: ProjectId
    readonly trigger: HTMLElement | null
  } | null>(null)
  if (workspace === undefined) return null
  const projects = userProjects(workspace)
  const removingEntry = projects.find((entry) => entry.project.projectId === removing?.projectId)
  const remove = (projectId: ProjectId, trigger: HTMLElement | null) => {
    Effect.runFork(Effect.logDebug('Removing project from Settings', { projectId }))
    setRemoving({ projectId, trigger })
  }
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <SettingsSectionHeading id="projects-heading">Projects</SettingsSectionHeading>
      {projects.length === 0 ? (
        <NoProjects />
      ) : (
        <List aria-labelledby="projects-heading">
          {projects.map((entry) => (
            <ProjectRow
              key={entry.project.projectId}
              entry={entry}
              onRemove={(trigger) => remove(entry.project.projectId, trigger)}
            />
          ))}
        </List>
      )}
      {removingEntry === undefined ? null : (
        <RemoveProjectDialog
          key={removingEntry.project.projectId}
          entry={removingEntry}
          onClose={() => setRemoving(null)}
          returnFocus={removing?.trigger}
        />
      )}
    </div>
  )
}
