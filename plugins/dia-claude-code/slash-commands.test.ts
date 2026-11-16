import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber, Option } from 'effect'
import { TestClock } from 'effect/testing'
import { beforeEach, vi } from 'vitest'
import type { ClaudeInstall } from './claude-install'
import {
  listSlashCommands,
  readSlashCommands,
  SLASH_COMMANDS_PROBE_TIMEOUT,
  SlashCommandsProbeFailed
} from './slash-commands'

const sdk = vi.hoisted(() => ({
  supportedCommands: vi.fn<() => Promise<Array<Record<string, unknown>>>>(),
  close: vi.fn(),
  options: vi.fn<(options: unknown) => void>()
}))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: (params: { options: unknown }) => {
    sdk.options(params.options)
    return { supportedCommands: sdk.supportedCommands, close: sdk.close }
  }
}))

const idleReporting = (supportedCommands: () => Promise<Array<Record<string, unknown>>>) =>
  ({ supportedCommands }) as unknown as Query

const installAt = (path: Option.Option<string>): ClaudeInstall => ({
  resolve: Effect.succeed(path),
  override: Effect.succeed(Option.none()),
  setOverride: () => Effect.void
})

const NO_ADDITIONS = { systemPromptAppend: '', pluginPaths: [] }

describe('readSlashCommands', () => {
  it.effect('maps each reported command to the renderer shape, defaulting missing aliases', () =>
    Effect.gen(function* () {
      const idle = idleReporting(() =>
        Promise.resolve([
          { name: 'review', description: 'Review a PR', argumentHint: '<pr>', aliases: ['rv'] },
          { name: 'init', description: 'Set up', argumentHint: '' }
        ])
      )

      const commands = yield* readSlashCommands(idle)

      assert.deepStrictEqual(commands, [
        { name: 'review', description: 'Review a PR', argumentHint: '<pr>', aliases: ['rv'] },
        { name: 'init', description: 'Set up', argumentHint: '', aliases: [] }
      ])
    })
  )

  it.effect('returns an empty list when Claude Code reports no commands', () =>
    Effect.gen(function* () {
      const commands = yield* readSlashCommands(idleReporting(() => Promise.resolve([])))

      assert.deepStrictEqual(commands, [])
    })
  )

  it.effect('fails with the rejection message when the read rejects', () =>
    Effect.gen(function* () {
      const idle = idleReporting(() => Promise.reject(new Error('spawn ENOENT')))

      const failure = yield* Effect.flip(readSlashCommands(idle))

      assert.deepStrictEqual(failure, new SlashCommandsProbeFailed({ message: 'spawn ENOENT' }))
    })
  )

  it.effect('fails when Claude Code does not answer within the timeout', () =>
    Effect.gen(function* () {
      const idle = idleReporting(() => Effect.runPromise(Effect.never))

      const fiber = yield* Effect.forkChild(Effect.flip(readSlashCommands(idle)))
      yield* TestClock.adjust(SLASH_COMMANDS_PROBE_TIMEOUT)
      const failure = yield* Fiber.join(fiber)

      assert.strictEqual(failure._tag, 'SlashCommandsProbeFailed')
      assert.strictEqual(failure.message, 'Claude Code did not report slash commands within 30s')
    })
  )
})

describe('listSlashCommands', () => {
  beforeEach(() => {
    sdk.supportedCommands.mockReset()
    sdk.close.mockReset()
    sdk.options.mockReset()
  })

  it.effect('returns no commands and starts no query when no install is found', () =>
    Effect.gen(function* () {
      const commands = yield* listSlashCommands(installAt(Option.none()))('/work', NO_ADDITIONS)

      assert.deepStrictEqual(commands, [])
      assert.strictEqual(sdk.options.mock.calls.length, 0)
    })
  )

  it.effect(
    'reads the commands from a query in cwd that loads the plugin paths, then closes it',
    () =>
      Effect.gen(function* () {
        sdk.supportedCommands.mockResolvedValue([
          { name: 'meta:plan', description: 'Plan', argumentHint: '' }
        ])

        const commands = yield* listSlashCommands(installAt(Option.some('/bin/claude')))('/work', {
          systemPromptAppend: '',
          pluginPaths: ['/meta/plugin']
        })

        assert.deepStrictEqual(commands, [
          { name: 'meta:plan', description: 'Plan', argumentHint: '', aliases: [] }
        ])
        const options = sdk.options.mock.calls[0]?.[0] as { cwd: string; plugins: unknown }
        assert.deepStrictEqual(
          { cwd: options.cwd, plugins: options.plugins },
          { cwd: '/work', plugins: [{ type: 'local', path: '/meta/plugin' }] }
        )
        assert.strictEqual(sdk.close.mock.calls.length, 1)
      })
  )

  it.effect('returns no commands and closes the query when the read fails', () =>
    Effect.gen(function* () {
      sdk.supportedCommands.mockRejectedValue(new Error('boom'))

      const commands = yield* listSlashCommands(installAt(Option.some('/bin/claude')))(
        '/work',
        NO_ADDITIONS
      )

      assert.deepStrictEqual(commands, [])
      assert.strictEqual(sdk.close.mock.calls.length, 1)
    })
  )
})
