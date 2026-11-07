// @effect-diagnostics asyncFunction:off -- React callbacks await OrgCall's Promise; components hold no Effect runtime.
import type { PluginServices } from '@dia/plugin'
import { Button, Input, Label, SettingsSectionHeading, Skeleton } from '@dia/renderer-plugin'
import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Cause, Result, Schema } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import { useId, useState } from 'react'
import { SetOverallCap } from './calls'
import { OverallCap } from './domain'
import { commonFailureText, type OrgAtom, useOrgCall } from './org-actions'

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

  const save = async () => {
    const next = decodeCap(text.trim() === '' ? Number.NaN : Number(text))
    if (Result.isFailure(next)) return setError('Enter a whole number of 1 or more')
    if (next.success === cap) return
    const result = await call(SetOverallCap, { cap: next.success }, 'overallCap')
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

/**
 * The Org page of the Settings dialog: the overall cap, saved on blur or Enter. It reads `orgAtom`
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
      <SettingsSectionHeading id="org-cap-heading">Hired agents</SettingsSectionHeading>
      {AsyncResult.match(result, {
        onInitial: () => <Skeleton className="h-8 w-full" aria-busy="true" />,
        onFailure: ({ cause }) => (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-error">{Cause.prettyErrors(cause)[0]?.message}</p>
            <Button size="sm" variant="outline" onClick={retry}>
              Try again
            </Button>
          </div>
        ),
        onSuccess: ({ value }) => (
          <CapField key={value.settings.overallCap} cap={value.settings.overallCap} call={call} />
        )
      })}
    </div>
  )
}
