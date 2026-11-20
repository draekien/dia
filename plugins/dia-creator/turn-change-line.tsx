// @effect-diagnostics asyncFunction:off -- React callbacks await Effect.runPromise; components hold no Effect runtime.
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import { Option } from 'effect'
import { AsyncResult, type Atom } from 'effect/reactivity'
import { Loader2Icon } from 'lucide-react'
import { useState } from 'react'
import type { CreatorThreadState, TurnChange, TurnCommit } from './calls'

/** A Creator thread's state by run id, as `FollowCreatorThread` streams it. */
export type CreatorThreadAtoms = (
  runId: string
) => Atom.Atom<AsyncResult.AsyncResult<Option.Option<CreatorThreadState>, unknown>>

/** The outcome of a revert or merge request: `null` when it succeeded, otherwise the text to show. */
export type ActionOutcome = Promise<string | null>

const short = (sha: string) => sha.slice(0, 7)

const CAPTION =
  'flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 pl-0.5 text-xs text-muted-foreground'

function Commits({ commits }: { readonly commits: ReadonlyArray<TurnCommit> }) {
  const [only] = commits
  if (commits.length === 1 && only !== undefined) {
    return (
      <span className="min-w-0 truncate">
        <span className="font-mono tabular-nums">{short(only.sha)}</span> {only.subject}
      </span>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the tooltip listing the commits
            tabIndex={0}
            className="cursor-default rounded-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {commits.length} commits
          </span>
        }
      />
      <TooltipContent>
        <ul className="flex flex-col gap-0.5">
          {commits.map((commit) => (
            <li key={commit.sha}>
              <span className="font-mono tabular-nums">{short(commit.sha)}</span> {commit.subject}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

const revertedLabel = (commits: ReadonlyArray<TurnCommit>) => {
  const [only] = commits
  return commits.length === 1 && only !== undefined ? short(only.sha) : `${commits.length} commits`
}

function Pending({ label }: { readonly label: string }) {
  return (
    <span className="inline-flex items-center" role="status" aria-label={label}>
      <Loader2Icon className="size-3 motion-safe:animate-spin" aria-hidden="true" />
    </span>
  )
}

/**
 * The props of {@link TurnChangeView}: the turn `change`, `unmerged` and `lastMerge` when this is
 * the thread's newest turn with commits (otherwise `undefined`), and `onRevert` and `onMerge`, which
 * resolve with `null` on success or the text of a failure.
 */
export interface TurnChangeViewProps {
  readonly change: TurnChange
  readonly merge: Pick<CreatorThreadState, 'unmerged' | 'lastMerge'> | undefined
  readonly onRevert: () => ActionOutcome
  readonly onMerge: () => ActionOutcome
}

/**
 * The lines at the end of one Creator turn: the plugins it loaded (or that did not reload), its
 * commits with `Revert` or the revert that undid them, and, on the newest turn with commits, how
 * many commits the meta repo lacks with `Merge`, or the last merge. A failed revert or merge shows
 * its reason in error red.
 */
export function TurnChangeView({ change, merge, onRevert, onMerge }: TurnChangeViewProps) {
  const [reverting, setReverting] = useState(false)
  const [revertError, setRevertError] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)

  const revert = async () => {
    setReverting(true)
    setRevertError(await onRevert())
    setReverting(false)
  }
  const runMerge = async () => {
    setMerging(true)
    setMergeError(await onMerge())
    setMerging(false)
  }

  const loaded = change.loads.filter((load) => load.loaded).map((load) => load.plugin)
  const failed = change.loads.filter((load) => !load.loaded).map((load) => load.plugin)
  const hasCommits = change.commits.length > 0

  return (
    <div className="flex flex-col">
      {loaded.length > 0 || hasCommits ? (
        <div className={CAPTION}>
          {loaded.length > 0 ? <span>Loaded {loaded.join(', ')}</span> : null}
          {hasCommits && change.revert !== null ? (
            <span>
              {revertedLabel(change.commits)} reverted in{' '}
              <span className="font-mono tabular-nums">{short(change.revert.sha)}</span>
            </span>
          ) : hasCommits ? (
            <>
              <Commits commits={change.commits} />
              {!change.ended ? null : reverting ? (
                <Pending label="Reverting" />
              ) : (
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => void revert()}
                >
                  Revert
                </Button>
              )}
            </>
          ) : null}
        </div>
      ) : null}
      {failed.map((plugin) => (
        <p key={plugin} className="pt-1 pl-0.5 text-xs text-foreground">
          {plugin} did not reload; the previous version is running
        </p>
      ))}
      {revertError === null ? null : (
        <p role="alert" className="pt-1 pl-0.5 text-xs text-error">
          Could not revert {revertedLabel(change.commits)}: {revertError}
        </p>
      )}
      {merge === undefined ? null : merge.unmerged > 0 ? (
        <div className={CAPTION}>
          <span>
            {merge.unmerged} {merge.unmerged === 1 ? 'commit' : 'commits'} not merged
          </span>
          {merging ? (
            <Pending label="Merging" />
          ) : (
            <Button
              variant="link"
              size="xs"
              className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void runMerge()}
            >
              Merge
            </Button>
          )}
        </div>
      ) : merge.lastMerge === null ? null : (
        <p className={CAPTION}>
          <span>
            Merged in <span className="font-mono tabular-nums">{short(merge.lastMerge.sha)}</span>
          </span>
        </p>
      )}
      {mergeError === null ? null : (
        <p role="alert" className="pt-1 pl-0.5 text-xs text-error">
          Could not merge: {mergeError}
        </p>
      )}
    </div>
  )
}

const newestWithCommits = (turns: ReadonlyArray<TurnChange>) =>
  [...turns].reverse().find((turn) => turn.commits.length > 0)

/**
 * The turn footer of Creator run `runId` for the turn its user messages `messageIds` opened:
 * {@link TurnChangeView} for that turn, following `threads(runId)`. Renders nothing for a turn
 * that changed nothing, and in a tab that is not a Creator thread.
 */
export function TurnChangeLine({
  runId,
  messageIds,
  threads,
  revert,
  merge
}: {
  readonly runId: string
  readonly messageIds: ReadonlyArray<string>
  readonly threads: CreatorThreadAtoms
  readonly revert: (runId: string, turnId: string) => ActionOutcome
  readonly merge: (runId: string) => ActionOutcome
}) {
  const result = useAtomValue(threads(runId))
  const state = AsyncResult.isSuccess(result) ? Option.getOrUndefined(result.value) : undefined
  if (state === undefined) return null
  const change = state.turns.find((turn) => turn.messageIds.some((id) => messageIds.includes(id)))
  if (change === undefined) return null
  const isNewest = newestWithCommits(state.turns)?.turnId === change.turnId
  return (
    <TurnChangeView
      change={change}
      merge={isNewest ? state : undefined}
      onRevert={() => revert(runId, change.turnId)}
      onMerge={() => merge(runId)}
    />
  )
}
