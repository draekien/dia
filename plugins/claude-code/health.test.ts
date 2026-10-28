import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk'
import { assert, describe, it } from '@effect/vitest'
import type { AdapterStatus } from '@shared/domain/adapter-status'
import { Deferred, Effect, Fiber, Layer, Option, Ref, Sink, Stream } from 'effect'
import { ChildProcessSpawner } from 'effect/process'
import { TestClock } from 'effect/testing'
import type { ClaudeInstall } from './claude-install'
import {
  type ClaudeHealth,
  InstallProbeFailed,
  isSignedOut,
  makeClaudeHealth,
  OVERRIDE_UNRUNNABLE,
  parseVersion,
  UPDATE_CLAUDE_CODE,
  VERSION_TIMEOUT
} from './health'

const INSTALL_PATH = 'C:\\Users\\me\\.local\\bin\\claude.exe'

const installAt = (
  resolved: Option.Option<string>,
  override: Option.Option<string> = Option.none()
): ClaudeInstall => ({
  resolve: Effect.succeed(resolved),
  override: Effect.succeed(override),
  setOverride: () => Effect.void
})

const versionProcess = (output: string, exitCode: number, exit = Effect.void) => {
  const bytes = Stream.make(new TextEncoder().encode(output))
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: exit.pipe(Effect.as(ChildProcessSpawner.ExitCode(exitCode))),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: bytes,
    stderr: Stream.empty,
    all: bytes,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void)
  })
}

const spawning = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.succeed(handle))
  )

const SIGNED_IN: AccountInfo = {
  email: 'me@example.com',
  subscriptionType: 'max',
  tokenSource: 'none',
  apiProvider: 'firstParty'
}

const SIGNED_OUT: AccountInfo = { tokenSource: 'none', apiProvider: 'firstParty' }

const answering = (account: AccountInfo) => (): Effect.Effect<AccountInfo, InstallProbeFailed> =>
  Effect.succeed(account)

const noRefresh = () => Effect.void

const healthAfterCheck = <R>(
  health: Effect.Effect<ClaudeHealth, never, R>
): Effect.Effect<AdapterStatus, never, R> =>
  Effect.gen(function* () {
    const built = yield* health
    yield* built.check
    return yield* Stream.runHead(built.status()).pipe(Effect.map(Option.getOrThrow))
  })

describe('parseVersion', () => {
  it('reads the version from claude --version output', () => {
    assert.deepStrictEqual(parseVersion('2.1.3 (Claude Code)\n'), Option.some('2.1.3'))
  })

  it('keeps a pre-release suffix', () => {
    assert.deepStrictEqual(parseVersion('2.2.0-beta.1 (Claude Code)'), Option.some('2.2.0-beta.1'))
  })

  it('is none when the output has no version', () => {
    assert.deepStrictEqual(parseVersion('command not found'), Option.none())
  })
})

describe('isSignedOut', () => {
  it('is true for Anthropic with no subscription, key or token', () => {
    assert.isTrue(isSignedOut(SIGNED_OUT, undefined))
  })

  it('is false with a claude.ai subscription', () => {
    assert.isFalse(isSignedOut(SIGNED_IN, undefined))
  })

  it('is false when ANTHROPIC_API_KEY is set', () => {
    assert.isFalse(isSignedOut(SIGNED_OUT, 'sk-ant-test'))
  })

  it('is false when the install reports an API key source', () => {
    assert.isFalse(isSignedOut({ ...SIGNED_OUT, apiKeySource: 'apiKeyHelper' }, undefined))
  })

  it('is false for a third-party provider, which authenticates outside Claude Code', () => {
    assert.isFalse(isSignedOut({ tokenSource: 'none', apiProvider: 'bedrock' }, undefined))
  })
})

describe('makeClaudeHealth', () => {
  it.effect('starts not checked', () =>
    Effect.gen(function* () {
      const health = yield* makeClaudeHealth(
        installAt(Option.some(INSTALL_PATH)),
        '/data',
        noRefresh
      )
      const status = yield* Stream.runHead(health.status()).pipe(Effect.map(Option.getOrThrow))
      assert.deepStrictEqual(status, {
        health: { _tag: 'HealthNotChecked' },
        checking: false,
        installPathOverride: null
      })
    }).pipe(Effect.scoped, Effect.provide(spawning(versionProcess('', 0))))
  )

  it.effect('reports not installed when no install is found and no override is stored', () =>
    Effect.gen(function* () {
      const status = yield* healthAfterCheck(
        makeClaudeHealth(installAt(Option.none()), '/data', noRefresh)
      )
      assert.strictEqual(status.health._tag, 'HealthNotInstalled')
    }).pipe(Effect.scoped, Effect.provide(spawning(versionProcess('', 0))))
  )

  it.effect('reports an error, not "not installed", when the stored override cannot be run', () =>
    Effect.gen(function* () {
      const status = yield* healthAfterCheck(
        makeClaudeHealth(
          installAt(Option.none(), Option.some('D:\\claude.exe')),
          '/data',
          noRefresh
        )
      )
      assert.strictEqual(status.health._tag, 'HealthError')
      assert.strictEqual(
        status.health._tag === 'HealthError' && status.health.message,
        OVERRIDE_UNRUNNABLE
      )
      assert.strictEqual(status.installPathOverride, 'D:\\claude.exe')
    }).pipe(Effect.scoped, Effect.provide(spawning(versionProcess('', 0))))
  )

  it.effect('reports an error with the output when claude --version exits non-zero', () =>
    Effect.gen(function* () {
      const status = yield* healthAfterCheck(
        makeClaudeHealth(
          installAt(Option.some(INSTALL_PATH)),
          '/data',
          noRefresh,
          answering(SIGNED_IN)
        )
      )
      assert.deepInclude(status.health, {
        _tag: 'HealthError',
        message: 'claude --version exited with code 1: broken install',
        installPath: INSTALL_PATH
      })
    }).pipe(Effect.scoped, Effect.provide(spawning(versionProcess('broken install', 1))))
  )

  it.effect('reports an error when claude --version does not finish in time', () =>
    Effect.gen(function* () {
      const health = yield* makeClaudeHealth(
        installAt(Option.some(INSTALL_PATH)),
        '/data',
        noRefresh,
        answering(SIGNED_IN)
      )
      const fiber = yield* Effect.forkChild(health.check)
      yield* TestClock.adjust(VERSION_TIMEOUT)
      yield* Fiber.join(fiber)
      const status = yield* Stream.runHead(health.status()).pipe(Effect.map(Option.getOrThrow))
      assert.deepInclude(status.health, {
        _tag: 'HealthError',
        message: 'claude --version did not finish within 10s'
      })
    }).pipe(Effect.scoped, Effect.provide(spawning(versionProcess('', 0, Effect.never))))
  )

  it.effect('reports unknown with the version when the account cannot be read', () =>
    Effect.gen(function* () {
      const status = yield* healthAfterCheck(
        makeClaudeHealth(installAt(Option.some(INSTALL_PATH)), '/data', noRefresh, () =>
          Effect.fail(new InstallProbeFailed({ message: 'spawn EINVAL' }))
        )
      )
      assert.deepInclude(status.health, {
        _tag: 'HealthUnknown',
        message: 'spawn EINVAL',
        version: '2.1.3'
      })
    }).pipe(Effect.scoped, Effect.provide(spawning(versionProcess('2.1.3 (Claude Code)', 0))))
  )

  it.effect('reports not signed in when the account has no sign-in', () =>
    Effect.gen(function* () {
      const status = yield* healthAfterCheck(
        makeClaudeHealth(
          installAt(Option.some(INSTALL_PATH)),
          '/data',
          noRefresh,
          answering(SIGNED_OUT)
        )
      )
      assert.strictEqual(status.health._tag, 'HealthNotSignedIn')
    }).pipe(Effect.scoped, Effect.provide(spawning(versionProcess('2.1.3 (Claude Code)', 0))))
  )

  it.effect('reports ready with the version, path, email and subscription', () =>
    Effect.gen(function* () {
      const status = yield* healthAfterCheck(
        makeClaudeHealth(
          installAt(Option.some(INSTALL_PATH)),
          '/data',
          noRefresh,
          answering(SIGNED_IN)
        )
      )
      assert.deepInclude(status.health, {
        _tag: 'HealthReady',
        version: '2.1.3',
        installPath: INSTALL_PATH,
        email: 'me@example.com',
        subscriptionType: 'max'
      })
      assert.isFalse(status.checking)
    }).pipe(Effect.scoped, Effect.provide(spawning(versionProcess('2.1.3 (Claude Code)', 0))))
  )

  it.effect('re-reads the model list when a failed install becomes ready', () =>
    Effect.gen(function* () {
      const install = yield* Ref.make(Option.none<string>())
      const refreshed = yield* Deferred.make<void>()
      const health = yield* makeClaudeHealth(
        { ...installAt(Option.none()), resolve: Ref.get(install) },
        '/data',
        () => Deferred.succeed(refreshed, undefined),
        answering(SIGNED_IN)
      )
      yield* health.check
      yield* Ref.set(install, Option.some(INSTALL_PATH))
      yield* health.check

      yield* Deferred.await(refreshed)
    }).pipe(Effect.scoped, Effect.provide(spawning(versionProcess('2.1.3 (Claude Code)', 0))))
  )

  it.effect(
    'does not re-read the model list on the first check, which the catalog already makes',
    () =>
      Effect.gen(function* () {
        const refreshes = yield* Ref.make(0)
        const health = yield* makeClaudeHealth(
          installAt(Option.some(INSTALL_PATH)),
          '/data',
          () => Ref.update(refreshes, (count) => count + 1),
          answering(SIGNED_IN)
        )
        yield* health.check
        assert.strictEqual(yield* Ref.get(refreshes), 0)
      }).pipe(Effect.scoped, Effect.provide(spawning(versionProcess('2.1.3 (Claude Code)', 0))))
  )

  it.effect(
    'a check requested during a running check waits for it instead of starting another',
    () =>
      Effect.gen(function* () {
        const probes = yield* Ref.make(0)
        const release = yield* Deferred.make<void>()
        const health = yield* makeClaudeHealth(
          installAt(Option.some(INSTALL_PATH)),
          '/data',
          noRefresh,
          () =>
            Ref.update(probes, (count) => count + 1).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(SIGNED_IN)
            )
        )
        const first = yield* Effect.forkChild(health.check)
        const second = yield* Effect.forkChild(health.check)
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        assert.strictEqual(yield* Ref.get(probes), 1)
      }).pipe(Effect.scoped, Effect.provide(spawning(versionProcess('2.1.3 (Claude Code)', 0))))
  )

  it.effect('a recheck during a running check runs a fresh check after it', () =>
    Effect.gen(function* () {
      const probes = yield* Ref.make(0)
      const release = yield* Deferred.make<void>()
      const health = yield* makeClaudeHealth(
        installAt(Option.some(INSTALL_PATH)),
        '/data',
        noRefresh,
        () =>
          Ref.update(probes, (count) => count + 1).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(SIGNED_IN)
          )
      )
      const first = yield* Effect.forkChild(health.check)
      yield* Effect.yieldNow
      const second = yield* Effect.forkChild(health.recheck)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      assert.strictEqual(yield* Ref.get(probes), 2)
    }).pipe(Effect.scoped, Effect.provide(spawning(versionProcess('2.1.3 (Claude Code)', 0))))
  )

  it.effect('a too-old CLI at session start sets health to Update Claude Code', () =>
    Effect.gen(function* () {
      const health = yield* makeClaudeHealth(
        installAt(Option.some(INSTALL_PATH)),
        '/data',
        noRefresh
      )
      yield* health.reportStartupFailure('cli_version_too_old')
      const status = yield* Stream.runHead(health.status()).pipe(Effect.map(Option.getOrThrow))
      assert.deepInclude(status.health, { _tag: 'HealthError', message: UPDATE_CLAUDE_CODE })
    }).pipe(Effect.scoped, Effect.provide(spawning(versionProcess('', 0))))
  )

  it.effect('another startup failure leaves health unchanged', () =>
    Effect.gen(function* () {
      const health = yield* makeClaudeHealth(
        installAt(Option.some(INSTALL_PATH)),
        '/data',
        noRefresh
      )
      yield* health.reportStartupFailure('cwd_unavailable')
      const status = yield* Stream.runHead(health.status()).pipe(Effect.map(Option.getOrThrow))
      assert.strictEqual(status.health._tag, 'HealthNotChecked')
    }).pipe(Effect.scoped, Effect.provide(spawning(versionProcess('', 0))))
  )
})
