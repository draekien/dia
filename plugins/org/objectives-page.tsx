import {
  Button,
  cn,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Skeleton,
  useWorkspace
} from '@dia/renderer-plugin'
import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Option } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import { useState } from 'react'
import type { WorkView } from './calls'
import type { Objective, ObjectiveId, ObjectivePriority } from './domain'
import { EntryList } from './entry-list'
import { ObjectiveDialog, type ProjectChoice } from './objective-dialog'
import { ObjectiveScreen } from './objective-screen'
import type { OrgScreen, WorkAtom } from './org-actions'
import { LoadFailure } from './org-fields'
import { ObjectivesView } from './org-view'

const PRIORITY_RANK: Record<ObjectivePriority, number> = { high: 0, normal: 1, low: 2 }

const listOrder = (a: Objective, b: Objective): number =>
  Number(a.state === 'completed') - Number(b.state === 'completed') ||
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
  b.createdAt - a.createdAt

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

function NoObjectives({ create }: { readonly create: () => void }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No objectives yet</EmptyTitle>
        <EmptyDescription>
          An objective is a goal in one of your projects, worked through as tasks by hired agents.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" variant="outline" onClick={create}>
          New objective…
        </Button>
      </EmptyContent>
    </Empty>
  )
}

function Objectives({
  objectiveId,
  work,
  projects,
  screen
}: {
  readonly objectiveId: ObjectiveId | null
  readonly work: WorkView
  readonly projects: ReadonlyArray<ProjectChoice>
  readonly screen: OrgScreen
}) {
  const { snapshot, call, show } = screen
  const [creating, setCreating] = useState(false)
  const objectives = [...work.objectives].sort(listOrder)
  const selected =
    objectiveId === null
      ? objectives[0]
      : objectives.find((objective) => objective.id === objectiveId)
  const projectName = (objective: Objective) =>
    projects.find((project) => project.id === objective.projectId)?.name ?? 'Removed project'

  return (
    <>
      {objectives.length === 0 ? (
        <NoObjectives create={() => setCreating(true)} />
      ) : (
        <div className="flex flex-col gap-6 @3xl:flex-row">
          <div className="flex max-w-sm flex-col gap-3 @3xl:w-56 @3xl:shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => setCreating(true)}
            >
              New objective…
            </Button>
            <EntryList
              label="Objectives"
              selectedId={selected?.id ?? objectiveId ?? undefined}
              onSelect={(id) => show(ObjectivesView.make({ objectiveId: id as ObjectiveId }))}
              entries={objectives.map((objective) => ({
                id: objective.id,
                content: (
                  <>
                    <span
                      className={cn(
                        'truncate',
                        objective.state === 'completed' && 'font-normal text-ink-muted'
                      )}
                    >
                      {objective.title}
                    </span>
                    <span className="ml-auto truncate text-xs font-normal text-ink-muted">
                      {projectName(objective)}
                    </span>
                  </>
                )
              }))}
            />
          </div>
          <div className="min-w-0 max-w-3xl flex-1">
            {selected === undefined ? (
              <DetailSkeleton />
            ) : (
              <ObjectiveScreen
                key={selected.id}
                objective={selected}
                projectName={projectName(selected)}
                tasks={work.tasks}
                snapshot={snapshot}
                call={call}
              />
            )}
          </div>
        </div>
      )}
      {creating ? (
        <ObjectiveDialog
          snapshot={snapshot}
          projects={projects}
          call={call}
          onCreated={(objective) => {
            setCreating(false)
            show(ObjectivesView.make({ objectiveId: objective.id }))
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  )
}

/**
 * The Objectives page: `New objective…`, every objective (open ones by priority, then newest,
 * completed ones last) with its project, and the detail of the selected one, `objectiveId`, or
 * the first when null. It follows `workAtom`, so changes the org makes show without a reload.
 */
export function ObjectivesPage({
  objectiveId,
  workAtom,
  ...screen
}: OrgScreen & { readonly objectiveId: ObjectiveId | null; readonly workAtom: WorkAtom }) {
  const result = useAtomValue(workAtom)
  const retry = useAtomRefresh(workAtom)
  const workspace = useWorkspace()
  const projects: ReadonlyArray<ProjectChoice> = (workspace?.projects ?? []).map(({ project }) => ({
    id: project.projectId,
    name: project.displayName
  }))

  return AsyncResult.match(result, {
    onInitial: () => (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-14 w-full max-w-3xl" />
        <Skeleton className="h-4 w-64" />
      </div>
    ),
    onFailure: ({ cause }) => <LoadFailure cause={cause} retry={retry} />,
    onSuccess: ({ value }) =>
      Option.match(value, {
        onNone: () => (
          <p className="text-sm text-ink-muted">The org plugin's host entry is not loaded.</p>
        ),
        onSome: (work) => (
          <Objectives objectiveId={objectiveId} work={work} projects={projects} screen={screen} />
        )
      })
  })
}
