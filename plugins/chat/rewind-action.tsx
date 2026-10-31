import { Button, type RewindRowState } from '@dia/renderer-plugin'
import { cva } from 'class-variance-authority'
import { Duration } from 'effect'
import { AlertTriangle, Loader2Icon, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/** How long the rewind control must be held before the rewind starts. */
export const HOLD_DURATION = Duration.seconds(1)

const HOLD_KEYS = new Set([' ', 'Enter'])

const rewindRow = cva(
  'flex min-h-6 items-center gap-2 pt-1 text-xs transition-opacity motion-reduce:transition-none',
  {
    variants: {
      state: {
        ready: 'opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100',
        blocked: 'opacity-0 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100',
        holding: 'opacity-100',
        rewinding: 'opacity-100 text-muted-foreground',
        failed: 'opacity-100'
      }
    }
  }
)

interface RewindActionProps {
  readonly state: RewindRowState
  readonly onStart: () => void
  readonly onDismiss: () => void
}

/**
 * The rewind row under an agent turn. Pressing and holding its control for {@link HOLD_DURATION}
 * (pointer, or Space/Enter held) calls `onStart`; releasing earlier cancels, and a click does
 * nothing. `state` comes from `rewindRowState`: `blocked` disables the control, `rewinding`
 * replaces it with a status line, and `failed` shows the failure beside the control with a
 * Dismiss button that calls `onDismiss`. The row is revealed on hover or focus of the enclosing
 * `group/turn` element, and stays visible while held, running or failed.
 */
export function RewindAction({ state, onStart, onDismiss }: RewindActionProps): React.JSX.Element {
  const [holding, setHolding] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const holdMs = Duration.toMillis(HOLD_DURATION)

  useEffect(() => () => clearTimeout(timer.current), [])

  const cancel = (): void => {
    clearTimeout(timer.current)
    timer.current = undefined
    setHolding(false)
  }
  const begin = (): void => {
    if (state.status === 'blocked' || timer.current !== undefined) return
    setHolding(true)
    // @effect-diagnostics-next-line globalTimers:off -- a React event handler times the hold; no Effect runtime exists in the renderer.
    timer.current = setTimeout(() => {
      timer.current = undefined
      setHolding(false)
      onStart()
    }, holdMs)
  }

  if (state.status === 'rewinding') {
    return (
      <div className={rewindRow({ state: 'rewinding' })}>
        <span role="status" className="flex items-center gap-1 px-1.5">
          <Loader2Icon
            aria-hidden="true"
            className="size-3 animate-spin motion-reduce:animate-none"
          />
          Rewinding…
        </span>
      </div>
    )
  }

  return (
    <div className={rewindRow({ state: holding ? 'holding' : state.status })}>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label="Rewind to here, press and hold"
        title="Press and hold to rewind to here"
        disabled={state.status === 'blocked'}
        data-holding={holding}
        style={{ '--hold-duration': `${holdMs}ms` } as React.CSSProperties}
        className="group/hold relative gap-1 overflow-hidden text-muted-foreground hover:text-foreground data-[holding=true]:text-foreground"
        onPointerDown={(event) => {
          if (event.button === 0) begin()
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onKeyDown={(event) => {
          if (!HOLD_KEYS.has(event.key)) return
          event.preventDefault()
          if (!event.repeat) begin()
        }}
        onKeyUp={(event) => {
          if (HOLD_KEYS.has(event.key)) cancel()
        }}
        onBlur={cancel}
      >
        <span
          aria-hidden="true"
          className="absolute inset-0 origin-left scale-x-0 bg-foreground/10 group-data-[holding=true]/hold:scale-x-100 group-data-[holding=true]/hold:transition-transform group-data-[holding=true]/hold:duration-(--hold-duration) group-data-[holding=true]/hold:ease-linear motion-reduce:transition-none"
        />
        <RotateCcw className="relative" />
        <span className="relative">{holding ? 'Hold' : 'Rewind'}</span>
      </Button>
      {state.status === 'failed' && (
        <>
          <span role="alert" className="flex min-w-0 items-center gap-1 text-destructive">
            <AlertTriangle aria-hidden="true" className="size-3 shrink-0" />
            {state.message}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        </>
      )}
    </div>
  )
}
