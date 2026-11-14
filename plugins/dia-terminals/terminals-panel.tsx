import type { PluginServices } from '@dia/plugin'
import { Button, callHost, cn, followHost, Status, StatusMedia, toast } from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Effect, Fiber, Option, Queue, Result, Stream } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { PlusIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  FollowTerminalOutput,
  FollowTerminals,
  OpenTerminal,
  RemoveTerminal,
  ResizeTerminal,
  StopTerminal,
  WriteTerminal
} from './calls'
import type { TerminalInfo } from './terminals'

const PLUGIN = 'dia-terminals'

/** Makes the atoms that follow each run's terminals for the `dia-terminals` renderer entry `ctx`. */
export const makeTerminalsAtoms = (ctx: Pick<PluginServices, 'name'>) =>
  Atom.family((runId: string) => Atom.make(followHost(ctx, FollowTerminals, { runId })))

/** The atom family {@link makeTerminalsAtoms} makes; {@link TerminalsPanel} reads one of its atoms. */
export type TerminalsAtoms = ReturnType<typeof makeTerminalsAtoms>

const toSrgbHex = (cssColor: string) => {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d')
  if (context === null) return cssColor
  context.fillStyle = cssColor
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
}

const run = (effect: Effect.Effect<unknown, unknown>, action: string) =>
  Effect.runFork(
    Effect.catch(effect, (error) =>
      Effect.logWarning('A terminal call failed', { action, error: String(error) })
    )
  )

const followOutput = (terminalId: string, terminal: Terminal) =>
  followHost(PLUGIN, FollowTerminalOutput, { terminalId }).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() =>
        Option.match(chunk, {
          onNone: () => terminal.reset(),
          onSome: (data) => terminal.write(data)
        })
      )
    )
  )

const sendInput = (terminalId: string, input: Queue.Queue<string>) =>
  Stream.fromQueue(input).pipe(
    Stream.runForEach((data) =>
      callHost(PLUGIN, WriteTerminal, { terminalId, data }).pipe(
        Effect.catch((error) =>
          Effect.logWarning('A terminal call failed', { action: 'write', error: String(error) })
        )
      )
    )
  )

function TerminalView({ terminalId }: { readonly terminalId: string }): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = container.current
    if (element === null) return
    const style = getComputedStyle(element)
    const foreground = toSrgbHex(style.color)
    const terminal = new Terminal({
      fontFamily: style.fontFamily,
      fontSize: 12,
      allowTransparency: true,
      theme: { background: '#00000000', foreground, cursor: foreground }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    const input = Effect.runSync(Queue.unbounded<string>())
    const fibers = [
      run(followOutput(terminalId, terminal), 'follow output'),
      run(sendInput(terminalId, input), 'write')
    ]
    const typed = terminal.onData((data) => Queue.offerUnsafe(input, data))
    let sizeReported = false
    const reportSize = ({ cols, rows }: { readonly cols: number; readonly rows: number }) => {
      sizeReported = true
      run(callHost(PLUGIN, ResizeTerminal, { terminalId, cols, rows }), 'resize')
    }
    const resized = terminal.onResize(reportSize)
    let pendingFit = 0
    const fitToView = () => {
      fit.fit()
      if (!sizeReported) reportSize(terminal)
    }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(pendingFit)
      pendingFit = requestAnimationFrame(fitToView)
    })
    observer.observe(element)
    return () => {
      cancelAnimationFrame(pendingFit)
      observer.disconnect()
      typed.dispose()
      resized.dispose()
      for (const fiber of fibers) Effect.runFork(Fiber.interrupt(fiber))
      terminal.dispose()
    }
  }, [terminalId])
  return (
    <div
      ref={container}
      className="min-h-0 flex-1 overflow-hidden px-3 py-1 font-mono text-ink [&_.xterm-viewport]:bg-transparent!"
    />
  )
}

const tabTitle = (info: TerminalInfo) =>
  info._tag === 'TerminalRunning' ? info.title : `${info.title}, exit code ${info.exitCode}`

function TerminalTab({
  info,
  selected,
  onSelect
}: {
  readonly info: TerminalInfo
  readonly selected: boolean
  readonly onSelect: () => void
}): React.JSX.Element {
  const running = info._tag === 'TerminalRunning'
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={tabTitle(info)}
      onClick={onSelect}
      className={cn(
        'flex h-6 max-w-48 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        selected ? 'bg-primary/10 text-ink hover:bg-primary/10' : 'text-ink-muted'
      )}
    >
      <Status className="shrink-0">
        <StatusMedia fill={running ? 'half' : 'full'} />
      </Status>
      <span className="truncate font-mono">{info.title}</span>
      <span className="sr-only">{running ? 'Running' : `Exited, exit code ${info.exitCode}`}</span>
    </button>
  )
}

const openTerminal = (runId: string, onOpened: (terminalId: string) => void) =>
  Effect.gen(function* () {
    yield* Effect.logInfo('Opening a terminal from the bottom panel', { runId })
    const opened = yield* Effect.result(callHost(PLUGIN, OpenTerminal, { runId }))
    if (Result.isSuccess(opened)) return onOpened(opened.success.terminalId)
    yield* Effect.logWarning('Could not open a terminal', { runId, reason: opened.failure._tag })
    toast.add({ title: 'Could not open a terminal', type: 'error' })
  })

function StopOrRemove({ info }: { readonly info: TerminalInfo }): React.JSX.Element {
  const running = info._tag === 'TerminalRunning'
  const { terminalId } = info
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() =>
        run(
          callHost(PLUGIN, running ? StopTerminal : RemoveTerminal, { terminalId }),
          running ? 'stop' : 'remove'
        )
      }
    >
      {running ? 'Stop' : 'Remove'}
    </Button>
  )
}

/**
 * The bottom panel's Terminals panel for run `runId`: a row with one tab per terminal, a `Stop` or
 * `Remove` button for the selected terminal and a `New terminal` button that opens a shell in the
 * run's working directory, then the selected terminal (the newest by default) sized to the panel,
 * which takes keyboard input. It follows `terminalsAtoms(runId)`.
 */
export function TerminalsPanel({
  runId,
  terminalsAtoms
}: {
  readonly runId: string
  readonly terminalsAtoms: TerminalsAtoms
}): React.JSX.Element {
  const result = useAtomValue(terminalsAtoms(runId))
  const terminals = AsyncResult.isSuccess(result) ? Option.getOrElse(result.value, () => []) : []
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const selected = terminals.find((each) => each.terminalId === chosen) ?? terminals.at(-1)
  const open = () => run(openTerminal(runId, setChosen), 'open')

  if (selected === undefined) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-ink-muted">No terminals</p>
        <Button size="sm" variant="outline" onClick={open}>
          <PlusIcon data-icon="inline-start" />
          New terminal
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none">
          {terminals.map((info) => (
            <TerminalTab
              key={info.terminalId}
              info={info}
              selected={info.terminalId === selected.terminalId}
              onSelect={() => setChosen(info.terminalId)}
            />
          ))}
        </div>
        <StopOrRemove info={selected} />
        <Button size="icon-xs" variant="ghost" aria-label="New terminal" onClick={open}>
          <PlusIcon />
        </Button>
      </div>
      <TerminalView key={selected.terminalId} terminalId={selected.terminalId} />
    </div>
  )
}
