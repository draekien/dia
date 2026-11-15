import type { PluginServices } from '@dia/plugin'
import { Button, callHost } from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import { Effect, Option } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { useEffect, useState } from 'react'
import { OpenAssistant } from './calls'
import { openAssistant } from './onboarding'
import type { LiveAtom } from './org-actions'

/**
 * An atom of the Executive assistant's run id from `liveAtom`, or null while it has none or the
 * org host entry is not serving.
 */
export const assistantRunIdAtom = (liveAtom: LiveAtom): Atom.Atom<string | null> =>
  Atom.map(liveAtom, (result) =>
    AsyncResult.isSuccess(result)
      ? Option.match(result.value, { onNone: () => null, onSome: (live) => live.assistantRunId })
      : null
  )

type Opening = 'opening' | 'failed'

const openAssistantRun = (ctx: Pick<PluginServices, 'name'>) =>
  Effect.runPromise(
    callHost(ctx, OpenAssistant, {}).pipe(
      Effect.tap((runId) => Effect.promise(() => openAssistant(runId))),
      Effect.as<Opening>('opening'),
      Effect.catch((failure) =>
        Effect.logWarning('Could not open the Executive assistant', { failure }).pipe(
          Effect.as<Opening>('failed')
        )
      )
    )
  )

function OpeningAssistant({
  ctx,
  onRetry
}: {
  readonly ctx: Pick<PluginServices, 'name'>
  readonly onRetry: () => void
}) {
  const [opening, setOpening] = useState<Opening>('opening')
  useEffect(() => {
    void openAssistantRun(ctx).then(setOpening)
  }, [ctx])
  if (opening === 'opening') return null
  return (
    <>
      <p className="text-sm text-ink-muted">The Executive assistant could not be opened.</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </>
  )
}

/**
 * The Assistant page, shown while the Executive assistant has no run. While its job title is
 * enabled it starts a run that waits for its first message and shows the run's tab, an empty
 * thread; otherwise it says why the assistant cannot take requests.
 */
export function AssistantPage({
  ctx,
  liveAtom
}: {
  readonly ctx: Pick<PluginServices, 'name'>
  readonly liveAtom: LiveAtom
}) {
  const result = useAtomValue(liveAtom)
  const [attempt, setAttempt] = useState(0)
  if (!AsyncResult.isSuccess(result)) return null
  const enabled = Option.exists(result.value, (live) => live.assistantEnabled)
  return (
    <div className="flex flex-col items-start gap-3 px-6 py-5">
      {enabled ? (
        <OpeningAssistant
          key={attempt}
          ctx={ctx}
          onRetry={() => setAttempt((count) => count + 1)}
        />
      ) : (
        <>
          <h2 className="text-base font-semibold text-ink">Assistant</h2>
          <p className="text-sm text-ink-muted">
            The Executive assistant job title is disabled, so it cannot take requests.
          </p>
        </>
      )}
    </div>
  )
}
