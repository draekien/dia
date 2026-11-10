// @effect-diagnostics asyncFunction:off -- React callbacks await OrgCall's Promise; components hold no Effect runtime.
import type { PluginServices } from '@dia/plugin'
import { Input, Label, Skeleton, Switch, useWorkspace } from '@dia/renderer-plugin'
import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Result, Schema } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import { useId, useRef, useState } from 'react'
import { SetOverallCap, SetProjectWorktrees } from './calls'
import { OverallCap } from './domain'
import { commonFailureText, type OrgAtom, useOrgCall } from './org-actions'
import { LoadFailure } from './org-fields'

const decodeCap = Schema.decodeUnknownResult(OverallCap)

function CapField({
  cap,
  call
}: {
  readonly cap: OverallCap
  readonly call: ReturnType<typeof useOrgCall>
}) {
  const [text, setText] = useState(String(cap))
  const [error, setError] = useState<string | undefined>(undefined)
  const inputId = useId()
  const errorId = useId()
  const saving = useRef(false)

  const save = async () => {
    const next = decodeCap(text.trim() === '' ? Number.NaN : Number(text))
    if (Result.isFailure(next)) return setError('Enter a whole number of 1 or more')
    if (next.success === cap || saving.current) return
    saving.current = true
    const result = await call(SetOverallCap, { cap: next.success }, 'overallCap').finally(() => {
      saving.current = false
    })
    if (Result.isFailure(result)) setError(commonFailureText(result.failure))
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor={inputId}>Hired agents running at once</Label>
        <Input
          id={inputId}
          type="number"
          min={1}
          step={1}
          value={text}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : errorId}
          onChange={(event) => {
            setText(event.target.value)
            setError(undefined)
          }}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save()
          }}
          className="h-8 w-20 tabular-nums"
        />
      </div>
      {error === undefined ? null : (
        <p id={errorId} className="text-xs text-error">
          {error}
        </p>
      )}
      <p className="text-xs text-ink-muted">
        The most hired agents that run at the same time, across every job title.
      </p>
    </div>
  )
}

function WorktreeSwitches({
  enabled,
  call
}: {
  readonly enabled: ReadonlyArray<string>
  readonly call: ReturnType<typeof useOrgCall>
}) {
  const id = useId()
  const projects = (useWorkspace()?.projects ?? []).filter(({ project }) => project.isGitRepo)
  if (projects.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Run issues in worktrees</p>
        <p className="text-xs text-ink-muted">
          Each issue a hired agent starts gets its own git worktree and branch in these projects.
        </p>
      </div>
      {projects.map(({ project }) => (
        <div key={project.projectId} className="flex items-center justify-between gap-4">
          <Label htmlFor={`${id}-${project.projectId}`}>{project.displayName}</Label>
          <Switch
            id={`${id}-${project.projectId}`}
            checked={enabled.includes(project.projectId)}
            onCheckedChange={(checked) =>
              void call(
                SetProjectWorktrees,
                { projectId: project.projectId, enabled: checked },
                'worktreeProjects'
              )
            }
          />
        </div>
      ))}
    </div>
  )
}

/**
 * The Org page of the Settings dialog: the overall cap, saved on blur or Enter, and a switch per
 * git project for running its issues in worktrees. It reads `orgAtom`
 * while shown; `ctx` is the `org` renderer entry the call goes through. It has no sections.
 */
export function OrgSettingsPage({
  ctx,
  orgAtom
}: {
  readonly ctx: Pick<PluginServices, 'name'>
  readonly orgAtom: OrgAtom
}) {
  const result = useAtomValue(orgAtom)
  const retry = useAtomRefresh(orgAtom)
  const call = useOrgCall(ctx, orgAtom)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 py-6">
      {AsyncResult.match(result, {
        onInitial: () => <Skeleton className="h-8 w-full" aria-busy="true" />,
        onFailure: ({ cause }) => <LoadFailure cause={cause} retry={retry} />,
        onSuccess: ({ value }) => (
          <>
            <CapField key={value.settings.overallCap} cap={value.settings.overallCap} call={call} />
            <WorktreeSwitches enabled={value.worktreeProjects} call={call} />
          </>
        )
      })}
    </div>
  )
}
