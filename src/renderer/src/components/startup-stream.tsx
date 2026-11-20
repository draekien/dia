import { cva } from 'class-variance-authority'
import { Duration } from 'effect'
import { useLayoutEffect, useRef } from 'react'
import { useNow } from '../hooks/use-now'
import { useStartupLog } from '../hooks/use-startup-log'
import { describeStartup, type StartupLine, type StartupWaiting } from '../lib/startup-lines'
import { StatusMedia } from './status'

const TICK = Duration.millis(100)
const STUCK_TO_BOTTOM_SLACK_PX = 8

const seconds = (millis: number, digits: number): string => `${(millis / 1000).toFixed(digits)}s`

const verbClass = cva('', {
  variants: {
    verb: {
      loading: 'text-ink-muted',
      loaded: 'text-ink',
      failed: 'font-medium text-error',
      waiting: 'text-ink',
      'restart required': 'text-ink',
      skipped: 'text-ink-muted'
    }
  }
})

function LineContent({ line }: { line: StartupLine }) {
  if (line._tag === 'HostStep') return <span className="text-ink">{line.text}</span>
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex items-baseline gap-3">
        <span className="w-[22ch] shrink-0 truncate font-mono text-ink">{line.plugin}</span>
        <span className={verbClass({ verb: line.verb })}>{line.verb}</span>
        {line.durationMillis !== undefined && (
          <span className="text-ink-muted tabular-nums">{seconds(line.durationMillis, 2)}</span>
        )}
      </span>
      {line.detail !== undefined && (
        <span className="line-clamp-2 font-mono break-words text-ink-muted">{line.detail}</span>
      )}
    </span>
  )
}

function StartupLogLines({ lines }: { lines: ReadonlyArray<StartupLine> }) {
  const scrollRef = useRef<HTMLOListElement>(null)
  const stuckToBottom = useRef(true)

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element !== null && stuckToBottom.current && lines.length > 0) {
      element.scrollTop = element.scrollHeight
    }
  }, [lines.length])

  const onScroll = () => {
    const element = scrollRef.current
    if (element === null) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    stuckToBottom.current = distance <= STUCK_TO_BOTTOM_SLACK_PX
  }

  return (
    <ol
      ref={scrollRef}
      onScroll={onScroll}
      aria-label="Startup steps"
      className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto text-xs leading-5"
    >
      {lines.map((line) => (
        <li key={line.key} className="flex animate-stream-enter gap-4 motion-reduce:animate-none">
          <span className="w-14 shrink-0 text-right text-ink-muted tabular-nums">
            +{seconds(line.offsetMillis, 2)}
          </span>
          <LineContent line={line} />
        </li>
      ))}
    </ol>
  )
}

function PinnedWaiting({ waiting }: { waiting: StartupWaiting }) {
  const now = useNow(TICK)
  const elapsed =
    waiting.sinceMillis === undefined ? undefined : Math.max(0, now - waiting.sinceMillis)
  return (
    <div className="flex items-center gap-2 border-t border-border pt-3 text-sm">
      <StatusMedia
        fill="full"
        className="text-ink-muted animate-pulse-slow motion-reduce:animate-none"
      />
      <span role="status" aria-live="polite" className="text-ink">
        {waiting.label}
        {waiting.plugin !== undefined && (
          <>
            {' '}
            <span className="font-mono">{waiting.plugin}</span>
          </>
        )}
      </span>
      {elapsed !== undefined && (
        <span aria-hidden="true" className="text-ink-muted tabular-nums">
          {seconds(elapsed, 1)}
        </span>
      )}
    </div>
  )
}

/**
 * The startup event stream: each startup step of the current Host run as a line, oldest first,
 * and a pinned line naming the step dia is waiting on with its elapsed time. Render it in place of
 * the pane area until the workspace loads; it reads the startup log from main itself.
 */
export function StartupStream() {
  const { lines, waiting } = describeStartup(useStartupLog())
  return (
    <section
      aria-label="Starting dia"
      className="flex h-full min-h-0 flex-col gap-3 px-6 pt-4 pb-6"
    >
      <StartupLogLines lines={lines} />
      <PinnedWaiting waiting={waiting} />
    </section>
  )
}
