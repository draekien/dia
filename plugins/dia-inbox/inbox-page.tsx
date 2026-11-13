// @effect-diagnostics asyncFunction:off -- React callbacks await Effect.runPromise; components hold no Effect runtime.
import type { PluginServices, RunAnswer } from '@dia/plugin'
import {
  actions,
  Button,
  callHost,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  followHost,
  Skeleton,
  toast,
  useProvided,
  useWorkspace
} from '@dia/renderer-plugin'
import { RequestCardKey } from '@dia-plugin/dia-chat/slots'
import {
  OpenRunInTab,
  ResolvePermission,
  ResolvePlanReview,
  ResolveQuestion
} from '@dia-plugin/dia-runs/calls'
import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Cause, Effect, Option, Result } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { createElement, useState } from 'react'
import { FollowInbox, type InboxItem } from './calls'

const RUNS = 'dia-runs'

/** Makes the atom that follows the inbox for the `dia-inbox` renderer entry `ctx`. */
export const makeInboxAtom = (ctx: Pick<PluginServices, 'name'>) =>
  Atom.make(followHost(ctx, FollowInbox, {}))

/** The atom {@link makeInboxAtom} makes; {@link InboxPage} reads it. */
export type InboxAtom = ReturnType<typeof makeInboxAtom>

const sendAnswer = (item: InboxItem, answer: RunAnswer) => {
  const target = { runId: item.runId, requestId: item.request.requestId }
  switch (answer._tag) {
    case 'PermissionAnswer':
      return callHost(RUNS, ResolvePermission, { ...target, response: answer.response })
    case 'QuestionAnswer':
      return callHost(RUNS, ResolveQuestion, { ...target, response: answer.response })
    case 'PlanReviewAnswer':
      return callHost(RUNS, ResolvePlanReview, { ...target, approved: answer.approved })
  }
}

const answerItem = (item: InboxItem, answer: RunAnswer) =>
  Effect.gen(function* () {
    yield* Effect.logInfo('Answering a run request from the inbox', {
      runId: item.runId,
      requestId: item.request.requestId,
      answer: answer._tag
    })
    const result = yield* Effect.result(sendAnswer(item, answer))
    if (Result.isSuccess(result)) return
    yield* Effect.logWarning('Could not answer a run request', {
      runId: item.runId,
      reason: result.failure._tag
    })
    toast.add({ title: 'Could not send your answer', description: 'Try again.', type: 'error' })
  })

const showRun = (runId: string, hasTab: boolean) =>
  Effect.gen(function* () {
    yield* Effect.logInfo('Showing a run from the inbox', { runId, hasTab })
    if (!hasTab) {
      const opened = yield* Effect.result(callHost(RUNS, OpenRunInTab, { runId }))
      if (Result.isFailure(opened) || !opened.success) {
        toast.add({ title: 'Could not open this agent', type: 'error' })
        return
      }
    }
    actions.selectTab(runId)
  })

const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd

function InboxEntry({ item }: { readonly item: InboxItem }) {
  const Card = useProvided(RequestCardKey)
  const project = useWorkspace()?.projects.find((entry) =>
    entry.tabs.some((tab) => tab.config.paneId === item.runId)
  )
  const hasTab = project !== undefined
  const [sending, setSending] = useState(false)
  const answer = async (given: RunAnswer) => {
    setSending(true)
    await Effect.runPromise(answerItem(item, given)).catch(() => undefined)
    setSending(false)
  }
  const label = project?.project.displayName ?? (item.cwd === '' ? 'Agent' : folderName(item.cwd))

  return (
    <section aria-label={`${label} needs you`} className="flex flex-col gap-1">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <p className="truncate font-medium text-ink text-sm">{label}</p>
          <p className="truncate font-mono text-ink-muted text-xs" title={item.cwd}>
            {item.runId}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void Effect.runPromise(showRun(item.runId, hasTab))}
        >
          Show
        </Button>
      </header>
      {sending ? (
        <p className="text-ink-muted text-sm">Sending your answer…</p>
      ) : Card === undefined ? (
        <p className="text-ink-muted text-sm">Open this agent to answer.</p>
      ) : (
        createElement(Card, { request: item.request, onAnswer: (given) => void answer(given) })
      )}
    </section>
  )
}

function Items({ items }: { readonly items: ReadonlyArray<InboxItem> }) {
  if (items.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No agent is waiting for you</EmptyTitle>
          <EmptyDescription>
            Permission requests, questions and plans from every agent appear here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="flex flex-col gap-6">
      {items.map((item) => (
        <InboxEntry key={`${item.runId}:${item.request.requestId}`} item={item} />
      ))}
    </div>
  )
}

/**
 * The Inbox page: every open permission request, question and plan review of every agent, with
 * or without a tab, each answerable in place and with Show to open its agent. It follows
 * `inboxAtom` while shown.
 */
export function InboxPage({ inboxAtom }: { readonly inboxAtom: InboxAtom }) {
  const result = useAtomValue(inboxAtom)
  const retry = useAtomRefresh(inboxAtom)

  return (
    <div className="@container h-full min-h-0 overflow-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-5">
        {AsyncResult.match(result, {
          onInitial: () => <Skeleton className="h-24 w-full" aria-busy="true" />,
          onFailure: ({ cause }) => (
            <div className="flex flex-col items-start gap-3">
              <p className="text-error text-sm">{Cause.prettyErrors(cause)[0]?.message}</p>
              <Button size="sm" variant="outline" onClick={retry}>
                Try again
              </Button>
            </div>
          ),
          onSuccess: ({ value }) =>
            Option.match(value, {
              onNone: () => (
                <p className="text-ink-muted text-sm">
                  The inbox plugin's host entry is not loaded.
                </p>
              ),
              onSome: (items) => <Items items={items} />
            })
        })}
      </div>
    </div>
  )
}
