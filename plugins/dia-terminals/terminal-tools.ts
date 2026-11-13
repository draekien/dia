import { type DiaTool, type DiaToolResult, diaTool, type ToolScope } from '@dia/plugin'
import { Effect, Option, Schema } from 'effect'
import type { TerminalInfo, Terminals } from './terminals'

const READ_CHARACTERS = 8000

const ANSI_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal escape sequences
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g

/** `text` with ANSI escape sequences (colours, cursor moves, titles) removed. */
export const stripAnsi = (text: string): string => text.replace(ANSI_SEQUENCE, '')

const result = (text: string, isError = false): DiaToolResult => ({ text, isError })

const stateText = (info: TerminalInfo) =>
  info._tag === 'TerminalRunning' ? 'running' : `exited with code ${info.exitCode}`

const TerminalIdInput = Schema.Struct({
  terminalId: Schema.String.annotate({ description: 'The id terminal_start returned.' })
})

const CommandInput = Schema.Struct({
  command: Schema.NonEmptyString.annotate({
    description:
      "The command line to run in the run's working directory, through PowerShell on Windows and the shell elsewhere."
  })
})

/**
 * The terminal tools a run uses to run commands that outlive a tool call, over `terminals`:
 * `terminal_start`, `terminal_read` and `terminal_stop`. Register them with `when: isRunScope`.
 * A run reads and stops only terminals it started or opened.
 */
export const makeTerminalTools = (terminals: Terminals): ReadonlyArray<DiaTool> => {
  const own = (terminalId: string, scope: ToolScope) =>
    Effect.map(terminals.read(terminalId), (snapshot) =>
      Option.filter(snapshot, ({ info }) => info.runId === scope.runId)
    )

  const notFound = (terminalId: string) =>
    result(`This run has no terminal with the id ${terminalId}.`, true)

  const start = diaTool({
    name: 'terminal_start',
    description:
      "Starts a command in a terminal in this run's working directory and returns at once with its terminal id. Use it for long-running processes such as dev servers and watchers; the user sees the terminal and can stop it. Read its output with terminal_read and end it with terminal_stop.",
    input: CommandInput,
    run: ({ command }, scope) =>
      scope.runId === undefined
        ? Effect.succeed(result('Only a dia run can start a terminal.', true))
        : terminals.open(scope.runId, command).pipe(
            Effect.map((info) => result(`Started terminal ${info.terminalId}: ${command}`)),
            Effect.catchTag('TerminalOpenError', (error) =>
              Effect.succeed(result(`The terminal did not start: ${error.message}`, true))
            )
          )
  })

  const read = diaTool({
    name: 'terminal_read',
    description:
      'Returns whether a terminal this run started is running or its exit code, and the end of its output (escape sequences removed).',
    input: TerminalIdInput,
    run: ({ terminalId }, scope) =>
      Effect.map(own(terminalId, scope), (snapshot) =>
        Option.match(snapshot, {
          onNone: () => notFound(terminalId),
          onSome: ({ info, output }) =>
            result(
              `Terminal ${terminalId} is ${stateText(info)}. Its output:\n\n${stripAnsi(output).slice(-READ_CHARACTERS)}`
            )
        })
      )
  })

  const stop = diaTool({
    name: 'terminal_stop',
    description: 'Stops the process of a terminal this run started.',
    input: TerminalIdInput,
    run: ({ terminalId }, scope) =>
      Effect.flatMap(own(terminalId, scope), (snapshot) =>
        Option.match(snapshot, {
          onNone: () => Effect.succeed(notFound(terminalId)),
          onSome: () =>
            Effect.as(terminals.stop(terminalId), result(`Stopped terminal ${terminalId}.`))
        })
      )
  })

  return [start, read, stop]
}
