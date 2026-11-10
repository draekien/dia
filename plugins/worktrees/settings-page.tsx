// @effect-diagnostics asyncFunction:off -- React callbacks await Effect.runPromise; components hold no Effect runtime.
import type { PluginServices } from '@dia/plugin'
import {
  Button,
  callHost,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
  followHost,
  List,
  ListRow,
  ListRowAction,
  ListRowDescription,
  ListRowFact,
  ListRowLink,
  ListRowName,
  ListRowSubject,
  SettingsSectionHeading,
  Skeleton,
  Status,
  StatusMedia,
  StatusName,
  toast
} from '@dia/renderer-plugin'
import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Cause, Effect, Option, Result } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { EllipsisIcon } from 'lucide-react'
import { useState } from 'react'
import {
  DiscardWorktree,
  KeepWorktree,
  type LedgerEntry,
  type LedgerState,
  WatchWorktrees
} from './calls'

/** Makes the atom that follows the ledger's rows for the `worktrees` renderer entry `ctx`. */
export const makeWorktreesAtom = (ctx: Pick<PluginServices, 'name'>) =>
  Atom.make(followHost(ctx, WatchWorktrees, {}))

/** The atom {@link makeWorktreesAtom} makes; {@link WorktreesSettings} reads it. */
export type WorktreesAtom = ReturnType<typeof makeWorktreesAtom>

const plural = (count: number) => `${count} changed ${count === 1 ? 'file' : 'files'}`

const stateName = (state: LedgerState): string => {
  switch (state._tag) {
    case 'Active':
      return 'In use'
    case 'NeedsDecision':
      return 'Needs decision'
    case 'Kept':
      return 'Kept'
    case 'Removed':
      return 'Removed'
  }
}

const stateFill = (state: LedgerState) => {
  switch (state._tag) {
    case 'Active':
      return 'half'
    case 'NeedsDecision':
      return 'none'
    case 'Kept':
    case 'Removed':
      return 'full'
  }
}

const changedFiles = (state: LedgerState): string =>
  state._tag === 'NeedsDecision' || state._tag === 'Kept' ? plural(state.changedFiles) : ''

const stateWord = (state: LedgerState): string => {
  switch (state._tag) {
    case 'Active':
      return 'in use'
    case 'NeedsDecision':
      return 'waiting for your decision'
    case 'Kept':
      return 'kept'
    case 'Removed':
      return 'removed'
  }
}

type Action = typeof DiscardWorktree | typeof KeepWorktree

const runAction = (ctx: Pick<PluginServices, 'name'>, action: Action, entry: LedgerEntry) =>
  Effect.gen(function* () {
    yield* Effect.logInfo('Worktree action', { action: action._tag, path: entry.info.path })
    const result = yield* Effect.result(callHost(ctx, action, { path: entry.info.path }))
    if (Result.isSuccess(result)) return
    yield* Effect.logWarning('Worktree action failed', {
      action: action._tag,
      reason: result.failure._tag
    })
    const failure = result.failure
    toast.add({
      title:
        failure._tag === 'LedgerStateChanged'
          ? `${entry.info.branch} is now ${stateWord(failure.state)}`
          : `Could not update ${entry.info.branch}`,
      description:
        failure._tag === 'LedgerStateChanged'
          ? 'The list shows its current state. Nothing was changed.'
          : failure.message,
      type: 'error'
    })
  })

function WorktreeRow({
  ctx,
  entry
}: {
  readonly ctx: Pick<PluginServices, 'name'>
  readonly entry: LedgerEntry
}) {
  const [pending, setPending] = useState(false)
  const act = async (action: Action) => {
    setPending(true)
    await Effect.runPromise(runAction(ctx, action, entry))
      .catch(() => undefined)
      .finally(() => setPending(false))
  }
  const decidable = entry.state._tag === 'NeedsDecision'
  const discardable = decidable || entry.state._tag === 'Kept'

  return (
    <ListRow value={entry.info.path}>
      <ListRowLink render={<div />} title={entry.info.path}>
        <ListRowSubject>
          <ListRowName className="font-mono">{entry.info.branch}</ListRowName>
          <ListRowDescription>{entry.owner.label}</ListRowDescription>
        </ListRowSubject>
        <ListRowFact>
          <Status>
            <StatusMedia fill={stateFill(entry.state)} />
            <StatusName>{stateName(entry.state)}</StatusName>
          </Status>
        </ListRowFact>
        <ListRowFact narrow="hide" className="text-ink-muted">
          {changedFiles(entry.state)}
        </ListRowFact>
      </ListRowLink>
      {discardable ? (
        <ListRowAction>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={pending}
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Actions for ${entry.info.branch}`}
                />
              }
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                {decidable ? (
                  <DropdownMenuItem onClick={() => void act(KeepWorktree)}>Keep</DropdownMenuItem>
                ) : null}
                <DropdownMenuItem variant="destructive" onClick={() => void act(DiscardWorktree)}>
                  Remove
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </ListRowAction>
      ) : null}
    </ListRow>
  )
}

/**
 * The Worktrees page of the Settings dialog: every git worktree dia created, with the branch, who
 * it serves and its state. A worktree left with modified or untracked files offers Keep
 * and Remove; a kept one offers Remove. It follows `worktreesAtom` while
 * shown; `ctx` is the `worktrees` renderer entry the actions go through.
 */
export function WorktreesSettings({
  ctx,
  worktreesAtom
}: {
  readonly ctx: Pick<PluginServices, 'name'>
  readonly worktreesAtom: WorktreesAtom
}) {
  const result = useAtomValue(worktreesAtom)
  const retry = useAtomRefresh(worktreesAtom)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <SettingsSectionHeading id="worktrees-heading">Worktrees</SettingsSectionHeading>
      {AsyncResult.match(result, {
        onInitial: () => <Skeleton className="h-24 w-full" aria-busy="true" />,
        onFailure: ({ cause }) => (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-error">{Cause.prettyErrors(cause)[0]?.message}</p>
            <Button size="sm" variant="outline" onClick={retry}>
              Try again
            </Button>
          </div>
        ),
        onSuccess: ({ value }) =>
          Option.match(value, {
            onNone: () => (
              <p className="text-sm text-ink-muted">
                The worktrees plugin's host entry is not loaded.
              </p>
            ),
            onSome: (entries) =>
              entries.length === 0 ? (
                <p className="text-sm text-ink-muted">dia has not created a worktree yet.</p>
              ) : (
                <List aria-labelledby="worktrees-heading">
                  {entries.map((entry) => (
                    <WorktreeRow key={entry.info.path} ctx={ctx} entry={entry} />
                  ))}
                </List>
              )
          })
      })}
    </div>
  )
}
