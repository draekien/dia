import type { PluginServices } from '@dia/plugin'
import {
  Button,
  callHost,
  cn,
  followHost,
  Status,
  StatusMedia,
  StatusName,
  toast
} from '@dia/renderer-plugin'
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
const VIEW_ROWS = 16

/** Makes the atoms that follow each run's terminals for the `dia-terminals` renderer entry `ctx`. */
export const makeTerminalsAtoms = (ctx: Pick<PluginServices, 'name'>) =>
  Atom.family((runId: string) => Atom.make(followHost(ctx, FollowTerminals, { runId })))

/** The atom family {@link makeTerminalsAtoms} makes; {@link TerminalsCard} reads one of its atoms. */
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
    Stream.runForEach((data) => callHost(PLUGIN, WriteTerminal, { terminalId, data }))
  )

function TerminalView({ terminalId }: { readonly terminalId: string }): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = container.current
    if (element === null) return
    const foreground = toSrgbHex(getComputedStyle(element).color)
    const terminal = new Terminal({
      rows: VIEW_ROWS,
      fontFamily: getComputedStyle(element).fontFamily,
      fontSize: 11,
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
    const resized = terminal.onResize(({ cols, rows }) =>
      run(callHost(PLUGIN, ResizeTerminal, { terminalId, cols, rows }), 'resize')
    )
    const fitToWidth = () => {
      const size = fit.proposeDimensions()
      if (size !== undefined && size.cols > 0) terminal.resize(size.cols, VIEW_ROWS)
    }
    const observer = new ResizeObserver(fitToWidth)
    observer.observe(element)
    fitToWidth()
    return () => {
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
      className="overflow-hidden rounded-md border px-1.5 py-1 font-mono text-foreground"
    />
  )
}

const stateLabel = (info: TerminalInfo) =>
  info._tag === 'TerminalRunning' ? 'Running' : `Exited ${info.exitCode}`

function TerminalRow({
  info,
  selected,
  onSelect
}: {
  readonly info: TerminalInfo
  readonly selected: boolean
  readonly onSelect: () => void
}): React.JSX.Element {
  const running = info._tag === 'TerminalRunning'
  const { terminalId } = info
  return (
    <li className="flex min-w-0 items-center gap-1">
      <button
        type="button"
        aria-pressed={selected}
        title={info.title}
        onClick={onSelect}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          selected && 'bg-muted'
        )}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{info.title}</span>
        <Status className="shrink-0 text-muted-foreground text-xs">
          <StatusMedia fill={running ? 'half' : 'full'} />
          <StatusName>{stateLabel(info)}</StatusName>
        </Status>
      </button>
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
    </li>
  )
}

const openTerminal = (runId: string, onOpened: (terminalId: string) => void) =>
  Effect.gen(function* () {
    yield* Effect.logInfo('Opening a terminal from the rail', { runId })
    const opened = yield* Effect.result(callHost(PLUGIN, OpenTerminal, { runId }))
    if (Result.isSuccess(opened)) return onOpened(opened.success.terminalId)
    yield* Effect.logWarning('Could not open a terminal', { runId, reason: opened.failure._tag })
    toast.add({ title: 'Could not open a terminal', type: 'error' })
  })

/**
 * The session rail's Terminals card body for run `runId`: its terminals with their state and a
 * Stop or Remove button, a `New terminal` button that opens a shell in the run's working
 * directory, and the selected terminal (the newest by default), which takes keyboard input.
 * It follows `terminalsAtoms(runId)`.
 */
export function TerminalsCard({
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
  return (
    <div className="flex flex-col gap-2">
      {terminals.length === 0 ? (
        <p className="text-muted-foreground">No terminals</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {terminals.map((info) => (
            <TerminalRow
              key={info.terminalId}
              info={info}
              selected={info.terminalId === selected?.terminalId}
              onSelect={() => setChosen(info.terminalId)}
            />
          ))}
        </ul>
      )}
      {selected !== undefined && (
        <TerminalView key={selected.terminalId} terminalId={selected.terminalId} />
      )}
      <Button
        size="sm"
        variant="outline"
        className="w-full"
        onClick={() => run(openTerminal(runId, setChosen), 'open')}
      >
        <PlusIcon data-icon="inline-start" />
        New terminal
      </Button>
    </div>
  )
}
