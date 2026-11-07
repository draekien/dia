import { useAtomValue } from '@effect/atom-react'
import { Cause } from 'effect'
import { AsyncResult, type Atom } from 'effect/reactivity'

/**
 * The example plugin's page: shows the greeting `greeting` reads from the plugin's `host` entry,
 * or why the read failed. The read runs while the page is shown.
 */
export function GreetingPage({
  greeting
}: {
  readonly greeting: Atom.Atom<AsyncResult.AsyncResult<string, { readonly message: string }>>
}) {
  const result = useAtomValue(greeting)

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-start gap-2">
        <h1 className="text-base font-semibold text-ink">Greeting from the host entry</h1>
        {AsyncResult.match(result, {
          onInitial: () => <p className="text-sm text-ink-muted">Asking the host…</p>,
          onSuccess: ({ value }) => <p className="text-sm text-ink">{value}</p>,
          onFailure: ({ cause }) => (
            <p className="text-sm text-error">{Cause.prettyErrors(cause)[0]?.message}</p>
          )
        })}
      </div>
    </div>
  )
}
