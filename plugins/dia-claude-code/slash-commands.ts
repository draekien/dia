import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { SlashCommandInfo } from '@dia/plugin'
import type { AgentBackend } from '@dia-plugin/dia-runs/backend'
import { Data, Duration, Effect, Option } from 'effect'
import { type ClaudeInstall, NOT_INSTALLED_REASON } from './claude-install'
import { messageOf, withIdleQuery } from './idle-query'
import { toSlashCommandInfo } from './reducer'

/** A `supportedCommands()` read that failed or did not answer within {@link SLASH_COMMANDS_PROBE_TIMEOUT}. */
export class SlashCommandsProbeFailed extends Data.TaggedError('SlashCommandsProbeFailed')<{
  readonly message: string
}> {}

/** How long a slash-command read waits for Claude Code to answer before it fails. */
export const SLASH_COMMANDS_PROBE_TIMEOUT = Duration.seconds(30)

/**
 * The slash commands `idle` reports, as the renderer's `/` menu reads them. Fails with
 * {@link SlashCommandsProbeFailed} when the read rejects or times out.
 */
export const readSlashCommands = (
  idle: Query
): Effect.Effect<ReadonlyArray<SlashCommandInfo>, SlashCommandsProbeFailed> =>
  Effect.tryPromise({
    try: () => idle.supportedCommands(),
    catch: (cause) => new SlashCommandsProbeFailed({ message: messageOf(cause) })
  }).pipe(
    Effect.timeout(SLASH_COMMANDS_PROBE_TIMEOUT),
    Effect.catchTag('TimeoutError', () =>
      Effect.fail(
        new SlashCommandsProbeFailed({
          message: `Claude Code did not report slash commands within ${Duration.format(SLASH_COMMANDS_PROBE_TIMEOUT)}`
        })
      )
    ),
    Effect.map((rows) => rows.map(toSlashCommandInfo))
  )

/** The {@link AgentBackend.slashCommands} of the Claude Code install `install` resolves. */
export const listSlashCommands =
  (install: ClaudeInstall): AgentBackend['slashCommands'] =>
  (cwd, additions) =>
    Effect.gen(function* () {
      yield* Effect.logDebug('Reading slash commands', {
        cwd,
        plugins: additions.pluginPaths.length
      })
      const path = yield* install.resolve
      if (Option.isNone(path)) {
        yield* Effect.logWarning('Cannot read slash commands', {
          cwd,
          reason: NOT_INSTALLED_REASON
        })
        return []
      }
      return yield* withIdleQuery(path.value, cwd, readSlashCommands, additions.pluginPaths).pipe(
        Effect.tap((read) => Effect.logInfo('Read slash commands', { cwd, count: read.length })),
        Effect.catchTag('SlashCommandsProbeFailed', (error) =>
          Effect.logWarning('Cannot read slash commands', { cwd, error: error.message }).pipe(
            Effect.as([])
          )
        )
      )
    })
