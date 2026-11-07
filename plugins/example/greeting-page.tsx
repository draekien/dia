import type { PluginServices } from '@dia/plugin'
import { callHost } from '@dia/renderer-plugin'
import { Effect } from 'effect'
import { useEffect, useState } from 'react'
import { ReadGreeting } from './messages'

type Greeting =
  | { readonly _tag: 'Loading' }
  | { readonly _tag: 'Read'; readonly text: string }
  | { readonly _tag: 'Failed'; readonly message: string }

/**
 * The example plugin's page: shows the greeting its `host` entry returns for `ReadGreeting`, or
 * why the call failed.
 */
export function GreetingPage({ ctx }: { readonly ctx: Pick<PluginServices, 'name'> }) {
  const [greeting, setGreeting] = useState<Greeting>({ _tag: 'Loading' })
  useEffect(() => {
    let mounted = true
    void Effect.runPromise(
      callHost(ctx, ReadGreeting, {}).pipe(
        Effect.match({
          onSuccess: (text): Greeting => ({ _tag: 'Read', text }),
          onFailure: (error): Greeting => ({ _tag: 'Failed', message: error.message })
        })
      )
    ).then(
      (result) => {
        if (mounted) setGreeting(result)
      },
      (defect: unknown) => {
        if (mounted) setGreeting({ _tag: 'Failed', message: String(defect) })
      }
    )
    return () => {
      mounted = false
    }
  }, [ctx])

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-start gap-2">
        <h1 className="text-base font-semibold text-ink">Greeting from the host entry</h1>
        {greeting._tag === 'Loading' && <p className="text-sm text-ink-muted">Asking the host…</p>}
        {greeting._tag === 'Read' && <p className="text-sm text-ink">{greeting.text}</p>}
        {greeting._tag === 'Failed' && <p className="text-sm text-error">{greeting.message}</p>}
      </div>
    </div>
  )
}
