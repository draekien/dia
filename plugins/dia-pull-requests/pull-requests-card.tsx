import { openRightPanel } from '@dia/renderer-plugin'
import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { Effect, Option } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import type { MouseEvent } from 'react'
import type { PullRequestAtoms } from './atoms'
import type { LinkedPullRequest } from './calls'
import { cardLines } from './summary'

const isMac =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent)

const OPEN_IN_BROWSER_HINT = `${isMac ? '⌘' : 'Ctrl'}+click to open in the browser`

const opensPanel = (event: MouseEvent): boolean =>
  event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey

/** The run's linked pull requests from `atoms`, or an empty list until the first answer. */
export const useRunPullRequests = (
  atoms: PullRequestAtoms,
  runId: string
): ReadonlyArray<LinkedPullRequest> => {
  const result = useAtomValue(atoms.runPullRequests(runId))
  return AsyncResult.isSuccess(result) ? (Option.getOrUndefined(result.value) ?? []) : []
}

function Row({
  pullRequest,
  onOpen
}: {
  readonly pullRequest: LinkedPullRequest
  readonly onOpen: () => void
}): React.JSX.Element {
  const { name, detail } = cardLines(pullRequest)
  return (
    <li>
      <a
        href={pullRequest.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Show ${name} in the Pull request panel`}
        title={OPEN_IN_BROWSER_HINT}
        onClick={(event) => {
          if (!opensPanel(event)) return
          event.preventDefault()
          onOpen()
        }}
        className="-mx-1 flex min-w-0 flex-col rounded-sm px-1 py-0.5 hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="truncate">{name}</span>
        <span className="truncate text-muted-foreground text-xs">{detail}</span>
      </a>
    </li>
  )
}

/**
 * The `Pull requests` rail card body for the tab showing run `runId`: one row per linked pull
 * request. Clicking a row shows it in the `Pull request` right panel, the list entry `panel` names; Ctrl+click (⌘+click on
 * macOS) or a middle click opens it in the browser instead.
 */
export function PullRequestsCard({
  runId,
  atoms,
  panel
}: {
  readonly runId: string
  readonly atoms: PullRequestAtoms
  readonly panel: { readonly plugin: string; readonly id: string }
}): React.JSX.Element {
  const pullRequests = useRunPullRequests(atoms, runId)
  const setShown = useAtomSet(atoms.shown(runId))
  if (pullRequests.length === 0) return <p className="text-muted-foreground">No pull requests</p>
  return (
    <ul className="flex flex-col gap-1">
      {pullRequests.map((pullRequest) => (
        <Row
          key={pullRequest.url}
          pullRequest={pullRequest}
          onOpen={() => {
            setShown(pullRequest.url)
            openRightPanel(runId, panel)
            Effect.runSync(
              Effect.logDebug('Opened a pull request in the panel', { runId, url: pullRequest.url })
            )
          }}
        />
      ))}
    </ul>
  )
}
