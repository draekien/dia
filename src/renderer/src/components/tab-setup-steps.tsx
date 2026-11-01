import { Marker, MarkerContent, MarkerIcon } from '@renderer/components/ui/marker'
import { formatElapsed } from '@renderer/lib/turn-activity'
import type { CopySetupStep, SetupStep, SetupStepState } from '@shared/domain/tab-setup'
import { AlertTriangle, Check, X } from 'lucide-react'

const LISTED_FILES_LIMIT = 5

const SHOWN_DURATION_MS = 1000

/**
 * The icon of one step row: a hollow ring while pending, a pulsing dot while running, a check
 * when done, an amber triangle for a warning and an `X` when failed. Decorative: put the state in
 * the row's text for screen readers.
 */
export function StepStatusIcon({ status }: { status: SetupStepState }): React.JSX.Element {
  switch (status) {
    case 'pending':
      return <span className="size-1.5 rounded-full border border-muted-foreground" />
    case 'running':
      return (
        <span className="size-1.5 animate-pulse-slow rounded-full bg-muted-foreground motion-reduce:animate-none" />
      )
    case 'warning':
      return <AlertTriangle className="size-3 text-pulse-amber" strokeWidth={2.5} />
    case 'failed':
      return <X className="size-3 text-foreground" strokeWidth={2.5} />
    case 'done':
      return <Check className="size-3 text-muted-foreground" strokeWidth={2.5} />
  }
}

/**
 * Whether a tab's setup steps should be on screen: while a step is pending or running, and after
 * a step failed. `undefined` (no setup reported) is false.
 */
export const showsSetup = (steps: ReadonlyArray<SetupStep> | undefined): boolean =>
  steps?.some(
    (step) => step.state === 'pending' || step.state === 'running' || step.state === 'failed'
  ) ?? false

const copyLabel = (step: CopySetupStep): string => {
  if (step.matchError !== undefined) return 'Copy files'
  const total = step.files.length
  const failed = step.files.filter((file) => file.error !== undefined).length
  const noun = total === 1 ? 'file' : 'files'
  return failed === 0 ? `Copy ${total} ${noun}` : `Copy ${total - failed} of ${total} ${noun}`
}

const stepLabel = (step: SetupStep): string => {
  switch (step._tag) {
    case 'WorktreeSetupStep':
      return step.reattach ? 'Reattach worktree' : 'Create worktree'
    case 'CopySetupStep':
      return copyLabel(step)
    case 'SessionSetupStep':
      return 'Start Claude Code session'
  }
}

const stepDetail = (step: SetupStep): string | undefined => {
  if (step._tag === 'WorktreeSetupStep') return step.branch
  if (step._tag === 'CopySetupStep') return '.worktreeinclude'
  return undefined
}

const stepError = (step: SetupStep): string | undefined =>
  step._tag === 'CopySetupStep' ? step.matchError : step.error

const listedFiles = (step: SetupStep): CopySetupStep['files'] => {
  if (step._tag !== 'CopySetupStep') return []
  if (step.files.length <= LISTED_FILES_LIMIT) return step.files
  return step.files.filter((file) => file.error !== undefined)
}

function SetupStepRow({ step }: { step: SetupStep }): React.JSX.Element {
  const detail = stepDetail(step)
  const error = stepError(step)
  const files = listedFiles(step)
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <Marker className="pl-0.5 text-xs">
        <MarkerIcon className="flex items-center justify-center">
          <StepStatusIcon status={step.state} />
        </MarkerIcon>
        <MarkerContent className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-foreground/90">{stepLabel(step)}</span>
          {detail !== undefined && (
            <span className="truncate font-mono" title={detail}>
              {detail}
            </span>
          )}
          {step.durationMs !== undefined && step.durationMs >= SHOWN_DURATION_MS && (
            <span className="ml-auto shrink-0 tabular-nums">{formatElapsed(step.durationMs)}</span>
          )}
        </MarkerContent>
        <span className="sr-only">{step.state}</span>
      </Marker>
      {files.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-0.5 pl-6 text-xs text-muted-foreground">
          {files.map((file) => (
            <li key={file.path} className="min-w-0 truncate" title={file.path}>
              <span className="font-mono">{file.path}</span>
              {file.error !== undefined && <span className="text-foreground"> — {file.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {error !== undefined && <p className="pl-6 text-xs text-destructive">{error}</p>}
    </li>
  )
}

/**
 * The setup steps of a worktree tab while it is created or resumed, one row per step in order:
 * its icon, its name, the branch or `.worktreeinclude`, and its duration once it took a second or
 * more. The copy step lists every file when it matched 5 or fewer, otherwise only the files it
 * could not copy; a failed step shows its error under it.
 */
export function TabSetupSteps({ steps }: { steps: ReadonlyArray<SetupStep> }): React.JSX.Element {
  return (
    <ol aria-label="Tab setup" className="flex min-w-0 flex-col gap-1.5">
      {steps.map((step) => (
        <SetupStepRow key={step._tag} step={step} />
      ))}
    </ol>
  )
}
