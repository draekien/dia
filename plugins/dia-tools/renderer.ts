import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry, callHost, toast } from '@dia/renderer-plugin'
import { CommandsSlot } from '@dia-plugin/dia-command-palette/slots'
import { Effect } from 'effect'
import { KeyRoundIcon, PlugIcon } from 'lucide-react'
import { IssueOutsideToken, RevokeOutsideTokens } from './calls'

const GROUP = 'Dia tools'

const failed = (title: string) => (cause: unknown) =>
  Effect.logError(title, { cause }).pipe(
    Effect.andThen(Effect.sync(() => toast.add({ title, type: 'error' })))
  )

const connect = (ctx: PluginServices) =>
  Effect.gen(function* () {
    const { command } = yield* callHost(ctx, IssueOutsideToken, {})
    yield* Effect.promise(() => navigator.clipboard.writeText(command))
    yield* Effect.logInfo('Copied a dia tools command for an outside agent')
    toast.add({
      title: 'Copied a Claude Code command',
      description:
        "Run it in a terminal to give Claude Code dia's tools. It holds a new token: keep it private.",
      type: 'success'
    })
  }).pipe(Effect.catchCause(failed('Could not create a dia tools token')))

const revoke = (ctx: PluginServices) =>
  Effect.gen(function* () {
    const revoked = yield* callHost(ctx, RevokeOutsideTokens, {})
    yield* Effect.logInfo('Revoked outside agent dia tools tokens', { revoked })
    toast.add({
      title: revoked === 1 ? 'Revoked 1 token' : `Revoked ${revoked} tokens`,
      description: 'Agents outside dia can no longer call dia tools.',
      type: 'success'
    })
  }).pipe(Effect.catchCause(failed('Could not revoke the dia tools tokens')))

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    yield* addEntry(ctx, CommandsSlot, {
      id: 'dia-tools-connect',
      order: 200,
      group: GROUP,
      label: 'Connect an outside agent to dia tools',
      icon: PlugIcon,
      keywords: ['mcp', 'token', 'claude code', 'terminal'],
      run: () => void Effect.runFork(connect(ctx))
    })
    yield* addEntry(ctx, CommandsSlot, {
      id: 'dia-tools-revoke',
      order: 201,
      group: GROUP,
      label: "Revoke outside agents' dia tools tokens",
      icon: KeyRoundIcon,
      keywords: ['mcp', 'token'],
      searchOnly: true,
      run: () => void Effect.runFork(revoke(ctx))
    })
  })

export default setup
