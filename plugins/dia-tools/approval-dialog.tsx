// @effect-diagnostics asyncFunction:off -- React callbacks await callHost's Promise; components hold no Effect runtime.
import type { PluginServices } from '@dia/plugin'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  callHost,
  followHost
} from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import { Effect, Option, Result } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { useState } from 'react'
import { AnswerApproval, type ApprovalSource, type PendingApproval, WatchApprovals } from './calls'
import type { ApprovalAnswer } from './tools'

const lastSegment = (path: string) =>
  path
    .split(/[\\/]/)
    .filter((part) => part !== '')
    .at(-1)

/** The line under the dialog's title that says which agent asked. */
export const sourceLine = (source: ApprovalSource): string => {
  if (source._tag === 'OutsideSource') return 'From an agent outside dia'
  const folder = source.project === null ? undefined : lastSegment(source.project)
  const where = folder === undefined ? 'From a run' : `From a run in ${folder}`
  return source.labels.length === 0 ? where : `${where} (${source.labels.join(', ')})`
}

const answerApproval = (ctx: Pick<PluginServices, 'name'>, id: string, answer: ApprovalAnswer) =>
  Effect.gen(function* () {
    yield* Effect.logInfo('Answering a tool approval', { id, answer })
    const result = yield* Effect.result(callHost(ctx, AnswerApproval, { id, answer }))
    if (Result.isFailure(result)) {
      yield* Effect.logWarning('Answering a tool approval failed', {
        id,
        reason: result.failure._tag
      })
    }
  })

function Change({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs text-ink-muted">{label}</span>
      <pre className="max-h-64 min-h-9 scrollbar-app overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-foreground/90">
        {text === '' ? <span className="font-sans text-ink-muted">(empty)</span> : text}
      </pre>
    </div>
  )
}

function Approval({
  ctx,
  approval,
  waiting
}: {
  readonly ctx: Pick<PluginServices, 'name'>
  readonly approval: PendingApproval
  readonly waiting: number
}) {
  const [busy, setBusy] = useState(false)
  const answer = (choice: ApprovalAnswer) => {
    setBusy(true)
    void Effect.runPromiseExit(answerApproval(ctx, approval.id, choice)).then(() => setBusy(false))
  }
  return (
    <AlertDialogContent className="sm:max-w-2xl">
      <AlertDialogHeader>
        <AlertDialogTitle>{approval.request.title}</AlertDialogTitle>
        <AlertDialogDescription>{sourceLine(approval.source)}</AlertDialogDescription>
      </AlertDialogHeader>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Change label="Before" text={approval.request.before} />
        <Change label="After" text={approval.request.after} />
      </div>
      <AlertDialogFooter className="items-center">
        {waiting > 0 ? (
          <span className="mr-auto text-xs text-ink-muted">{waiting} more waiting</span>
        ) : null}
        <Button variant="outline" disabled={busy} onClick={() => answer('declined')}>
          Decline
        </Button>
        <Button disabled={busy} onClick={() => answer('approved')}>
          Approve
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}

/** Makes the atom that follows the pending approvals for the `dia-tools` renderer entry `ctx`. */
export const makeApprovalsAtom = (ctx: Pick<PluginServices, 'name'>) =>
  Atom.make(followHost(ctx, WatchApprovals, {}))

/** The atom {@link makeApprovalsAtom} makes; {@link ApprovalDialog} reads it. */
export type ApprovalsAtom = ReturnType<typeof makeApprovalsAtom>

/**
 * The dialog that shows the oldest tool call waiting for the user's approval; add it to
 * `DialogsSlot`. `approvalsAtom` comes from {@link makeApprovalsAtom}, and `ctx` is the
 * `dia-tools` renderer entry the answer goes through. It is open while any request waits, and
 * closes only when the user has answered every one.
 */
export function ApprovalDialog({
  ctx,
  approvalsAtom
}: {
  readonly ctx: Pick<PluginServices, 'name'>
  readonly approvalsAtom: ApprovalsAtom
}) {
  const result = useAtomValue(approvalsAtom)
  const pending = AsyncResult.isSuccess(result) ? Option.getOrElse(result.value, () => []) : []
  const oldest = pending[0]
  return (
    <AlertDialog open={oldest !== undefined} onOpenChange={() => {}}>
      {oldest === undefined ? null : (
        <Approval key={oldest.id} ctx={ctx} approval={oldest} waiting={pending.length - 1} />
      )}
    </AlertDialog>
  )
}
