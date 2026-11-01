// @effect-diagnostics asyncFunction:off -- React callbacks await the Promise-based window.dia bridge; no Effect runtime exists in the renderer.
import type {
  MetaRepoPushResult,
  MetaRepoStateResult,
  SecretFinding
} from '@shared/domain/meta-repo'
import { Loader2Icon, ShieldAlertIcon, UploadIcon } from 'lucide-react'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Skeleton } from '../ui/skeleton'
import { Row, SectionHeading } from './section'

const SHORT_SHA_LENGTH = 7

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

function FindingRow({ finding }: { readonly finding: SecretFinding }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 py-2">
      <span className="text-sm text-ink">{finding.description}</span>
      <span
        className="font-mono text-xs text-ink-muted tabular-nums"
        title={`Commit ${finding.commit}`}
      >
        {finding.commit.slice(0, SHORT_SHA_LENGTH)}
      </span>
      <span className="col-span-2 font-mono text-xs break-all text-ink-muted">
        {finding.file === null
          ? `commit message, line ${finding.line}`
          : `${finding.file}:${finding.line}`}
      </span>
    </li>
  )
}

function PushOutcome({ result }: { readonly result: MetaRepoPushResult }) {
  switch (result._tag) {
    case 'MetaRepoPushed':
      return (
        <p className="text-sm text-ink">
          {result.commitCount === 0
            ? 'The remote already had every commit of '
            : `Pushed ${plural(result.commitCount, 'commit')} of `}
          <span className="font-mono text-xs">{result.branch}</span> to{' '}
          <span className="font-mono text-xs break-all">{result.remoteUrl}</span>.
        </p>
      )
    case 'MetaRepoPushRefused':
      return (
        <div className="flex flex-col gap-2">
          <p className="flex items-start gap-2 text-sm text-error">
            <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              Push refused. dia found {plural(result.findings.length, 'possible secret')} in the
              commits to push, and sent nothing.
            </span>
          </p>
          <ul aria-label="Findings" className="flex flex-col divide-y border-y">
            {result.findings.map((finding) => (
              <FindingRow
                key={`${finding.commit}:${finding.file ?? ''}:${finding.line}`}
                finding={finding}
              />
            ))}
          </ul>
          <p className="text-xs text-ink-muted">
            A later commit that deletes the value does not help: the commit that added it would
            still be pushed. Rewrite the commits that add it, then push again.
          </p>
        </div>
      )
    case 'MetaRepoFailed':
      return <p className="text-sm break-words text-error">{result.message}</p>
  }
}

function RemoteSection({
  state,
  onChange
}: {
  readonly state: MetaRepoStateResult | undefined
  readonly onChange: (next: MetaRepoStateResult) => void
}) {
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const errorId = useId()

  if (state === undefined) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
    )
  }
  if (state._tag === 'MetaRepoFailed') {
    return <p className="text-sm text-ink-muted">{state.message}</p>
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    const next = await window.dia.metaRepo.setRemote(url)
    setSaving(false)
    setError(next._tag === 'MetaRepoFailed' ? next.message : undefined)
    if (next._tag === 'MetaRepoFailed') return
    setUrl('')
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-2">
        <Row label="Remote">
          {state.remoteUrl === null ? (
            <span className="text-ink-muted">None</span>
          ) : (
            <span className="font-mono text-xs break-all">{state.remoteUrl}</span>
          )}
        </Row>
        <Row label="Branch">
          {state.branch === null ? (
            <span className="text-ink-muted">No branch checked out</span>
          ) : (
            <span className="font-mono text-xs">{state.branch}</span>
          )}
        </Row>
      </dl>
      <form className="flex flex-col gap-1.5" onSubmit={(event) => void submit(event)}>
        <div className="flex items-center gap-2">
          <Input
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              setError(undefined)
            }}
            placeholder="git@github.com:you/dia-meta.git"
            aria-label={state.remoteUrl === null ? 'Remote URL' : 'New remote URL'}
            aria-invalid={error !== undefined}
            aria-describedby={error === undefined ? undefined : errorId}
            spellCheck={false}
            autoComplete="off"
            className="h-8 font-mono text-xs md:text-xs"
          />
          <Button type="submit" size="sm" variant="outline" disabled={saving || url.trim() === ''}>
            {saving ? <Loader2Icon className="motion-safe:animate-spin" /> : null}
            {state.remoteUrl === null ? 'Add remote' : 'Change remote'}
          </Button>
        </div>
        {error === undefined ? null : (
          <p id={errorId} className="text-xs text-error">
            {error}
          </p>
        )}
      </form>
      <p className="text-xs text-ink-muted">
        dia pushes with your own git credentials, from a credential helper or an ssh agent.
      </p>
    </div>
  )
}

function PushSection({ state }: { readonly state: MetaRepoStateResult | undefined }) {
  const [pushing, setPushing] = useState(false)
  const [result, setResult] = useState<MetaRepoPushResult | undefined>(undefined)
  const ready = state?._tag === 'MetaRepoState' && state.remoteUrl !== null

  const push = async () => {
    setPushing(true)
    setResult(await window.dia.metaRepo.push())
    setPushing(false)
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        Before every push, dia scans the commits the remote does not have yet for API keys, tokens,
        private keys and passwords, and refuses the push when it finds one.
      </p>
      <div>
        <Button size="sm" disabled={!ready || pushing} onClick={() => void push()}>
          {pushing ? <Loader2Icon className="motion-safe:animate-spin" /> : <UploadIcon />}
          {pushing ? 'Scanning and pushing' : 'Push'}
        </Button>
      </div>
      <div aria-live="polite">{result === undefined ? null : <PushOutcome result={result} />}</div>
    </div>
  )
}

/**
 * The Meta repo settings page: the meta repo's remote and branch, a field that adds or changes
 * the remote, and a Push button that scans the unpushed commits for secrets and pushes the branch
 * when they hold none, showing each finding by rule, file, line and commit when it refuses. It
 * reads the state through `window.dia.metaRepo` on mount. Render it inside a scrolling container.
 */
export function MetaRepoSettings() {
  const [state, setState] = useState<MetaRepoStateResult | undefined>(undefined)

  useEffect(() => {
    let current = true
    void window.dia.metaRepo.getState().then((next) => {
      if (current) setState(next)
    })
    return () => {
      current = false
    }
  }, [])

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-6">
      <section className="flex flex-col gap-3" aria-labelledby="meta-remote-heading">
        <SectionHeading id="meta-remote-heading">Remote</SectionHeading>
        <RemoteSection state={state} onChange={setState} />
      </section>
      {state?._tag === 'MetaRepoFailed' ? null : (
        <section className="flex flex-col gap-3 border-t pt-6" aria-labelledby="meta-push-heading">
          <SectionHeading id="meta-push-heading">Push</SectionHeading>
          <PushSection state={state} />
        </section>
      )}
    </div>
  )
}
