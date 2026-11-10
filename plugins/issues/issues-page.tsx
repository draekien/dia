import type { PluginServices } from '@dia/plugin'
import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  List,
  ListRow,
  ListRowDescription,
  ListRowFact,
  ListRowLink,
  ListRowName,
  ListRowSubject,
  RelativeTime,
  Skeleton,
  Status,
  StatusMedia,
  StatusName,
  useWorkspace
} from '@dia/renderer-plugin'
import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Cause, DateTime, Option, Schema } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import { ChevronLeftIcon } from 'lucide-react'
import { useState } from 'react'
import type { IssuesView } from './calls'
import { type Objective, ObjectiveId, PRIORITY_LABELS, PRIORITY_RANK } from './domain'
import { type IssuesAtom, type IssuesCall, issuesCall } from './issue-actions'
import { ObjectiveDialog, type ProjectChoice } from './objective-dialog'
import { ObjectiveScreen } from './objective-screen'

const listOrder = (a: Objective, b: Objective): number =>
  Number(a.state === 'completed') - Number(b.state === 'completed') ||
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
  b.createdAt - a.createdAt

const isObjectiveId = Schema.is(ObjectiveId)

function LoadFailure({
  cause,
  retry
}: {
  readonly cause: Cause.Cause<unknown>
  readonly retry: () => void
}) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-error">{Cause.prettyErrors(cause)[0]?.message}</p>
      <Button size="sm" variant="outline" onClick={retry}>
        Try again
      </Button>
    </div>
  )
}

function NoObjectives({ create }: { readonly create: () => void }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>No objectives yet</EmptyTitle>
        <EmptyDescription>
          An objective is a goal in one of your projects, worked through as issues.
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

function ObjectiveList({
  objectives,
  projectName,
  open
}: {
  readonly objectives: ReadonlyArray<Objective>
  readonly projectName: (objective: Objective) => string
  readonly open: (objectiveId: ObjectiveId) => void
}) {
  const now = DateTime.formatIso(DateTime.nowUnsafe())
  return (
    <List aria-label="Objectives">
      {objectives.map((objective) => (
        <ListRow key={objective.id} value={objective.id}>
          <ListRowLink render={<button type="button" />} onClick={() => open(objective.id)}>
            <ListRowSubject>
              <ListRowName>{objective.title}</ListRowName>
              <ListRowDescription>{projectName(objective)}</ListRowDescription>
            </ListRowSubject>
            <ListRowFact narrow="abbreviate">
              <Status>
                <StatusMedia fill={objective.state === 'open' ? 'half' : 'full'} />
                <StatusName>{objective.state === 'open' ? 'Open' : 'Completed'}</StatusName>
              </Status>
            </ListRowFact>
            <ListRowFact narrow="hide" className="text-ink-muted">
              {PRIORITY_LABELS[objective.priority]}
            </ListRowFact>
            <ListRowFact narrow="abbreviate" className="text-ink-muted">
              <RelativeTime
                dateTime={DateTime.formatIso(DateTime.makeUnsafe(objective.createdAt))}
                now={now}
              />
            </ListRowFact>
          </ListRowLink>
        </ListRow>
      ))}
    </List>
  )
}

function Loaded({
  view,
  objectiveId,
  setObjectiveId,
  call
}: {
  readonly view: IssuesView
  readonly objectiveId: ObjectiveId | null
  readonly setObjectiveId: (objectiveId: ObjectiveId | null) => void
  readonly call: IssuesCall
}) {
  const [creating, setCreating] = useState(false)
  const workspace = useWorkspace()
  const projects: ReadonlyArray<ProjectChoice> = (workspace?.projects ?? []).map(({ project }) => ({
    id: project.projectId,
    name: project.displayName
  }))
  const projectName = (objective: Objective) =>
    projects.find((project) => project.id === objective.projectId)?.name ?? 'Removed project'
  const selected =
    objectiveId === null
      ? undefined
      : view.objectives.find((objective) => objective.id === objectiveId)

  const dialog = creating ? (
    <ObjectiveDialog
      projects={projects}
      call={call}
      onCreated={(objective) => {
        setCreating(false)
        setObjectiveId(objective.id)
      }}
      onClose={() => setCreating(false)}
    />
  ) : null

  if (objectiveId !== null) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => setObjectiveId(null)}
        >
          <ChevronLeftIcon data-icon="inline-start" />
          Objectives
        </Button>
        {selected === undefined ? (
          <div className="flex flex-col gap-4" aria-busy="true">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <ObjectiveScreen
            objective={selected}
            projectName={projectName(selected)}
            view={view}
            call={call}
          />
        )}
      </div>
    )
  }

  return (
    <>
      <div className="flex max-w-3xl items-center gap-3">
        <h2 className="flex-1 text-base font-semibold text-ink">Objectives</h2>
        {view.objectives.length === 0 ? null : (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            New objective…
          </Button>
        )}
      </div>
      {view.objectives.length === 0 ? (
        <NoObjectives create={() => setCreating(true)} />
      ) : (
        <ObjectiveList
          objectives={[...view.objectives].sort(listOrder)}
          projectName={projectName}
          open={setObjectiveId}
        />
      )}
      {dialog}
    </>
  )
}

/**
 * The Issues page in the content area. It lists every objective (open ones by priority, then
 * newest, completed ones last) with its project, state, priority and age, and shows one objective's
 * detail and issues when its row is chosen, or when `target` is that objective's id. It follows
 * `issuesAtom`, so changes show without a reload; `ctx` is the `issues` renderer entry the calls
 * go through.
 */
export function IssuesPage({
  ctx,
  issuesAtom,
  target
}: {
  readonly ctx: Pick<PluginServices, 'name'>
  readonly issuesAtom: IssuesAtom
  readonly target?: string | undefined
}) {
  const result = useAtomValue(issuesAtom)
  const retry = useAtomRefresh(issuesAtom)
  const [objectiveId, setObjectiveId] = useState<ObjectiveId | null>(() =>
    target !== undefined && isObjectiveId(target) ? target : null
  )
  const call = issuesCall(ctx)

  return (
    <div className="@container h-full min-h-0 overflow-auto">
      <div className="flex flex-col gap-5 px-6 py-5">
        {AsyncResult.match(result, {
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
                <p className="text-sm text-ink-muted">
                  The issues plugin's host entry is not loaded.
                </p>
              ),
              onSome: (view) => (
                <Loaded
                  view={view}
                  objectiveId={objectiveId}
                  setObjectiveId={setObjectiveId}
                  call={call}
                />
              )
            })
        })}
      </div>
    </div>
  )
}
