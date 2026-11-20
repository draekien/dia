// @vitest-environment jsdom
import {
  EagerPluginLoadSettled,
  EagerPluginLoadStarted,
  HostStarted,
  HostStarting,
  type StartupEvent,
  type StartupLog
} from '@shared/domain/startup'
import { PluginFailed } from '@shared/plugin/manifest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Deferred, Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StartupStream } from './startup-stream'

const LAUNCH = 1_700_000_000_000

const logOf = (...steps: ReadonlyArray<readonly [number, StartupEvent]>): StartupLog =>
  steps.map(([afterMillis, event]) => ({ atMillis: LAUNCH + afterMillis, event }))

const installBridge = (seed: Promise<StartupLog>) => {
  const listeners = new Set<(log: StartupLog) => void>()
  Object.assign(window, {
    dia: {
      getStartupLog: () => seed,
      onStartupLogChanged: (listener: (log: StartupLog) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  })
  return {
    push: (log: StartupLog) =>
      act(() => {
        for (const listener of listeners) listener(log)
      })
  }
}

const pendingSeed = () => {
  const seed = Effect.runSync(Deferred.make<StartupLog, Error>())
  return {
    promise: Effect.runPromise(Deferred.await(seed)),
    resolve: (log: StartupLog) => Effect.runSync(Deferred.succeed(seed, log)),
    reject: (error: Error) => Effect.runSync(Deferred.fail(seed, error))
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'dia')
})

describe('StartupStream', () => {
  it('shows the steps main recorded before the stream mounted', async () => {
    installBridge(Promise.resolve(logOf([0, HostStarting.make({})], [310, HostStarted.make({})])))

    render(<StartupStream />)

    expect(await screen.findByText('Host started')).toBeDefined()
    expect(screen.getByText('+0.31s')).toBeDefined()
  })

  it('keeps a pushed log when the earlier, shorter seed arrives after it', async () => {
    const seed = pendingSeed()
    const bridge = installBridge(seed.promise)
    render(<StartupStream />)
    const pushed = logOf([0, HostStarting.make({})], [310, HostStarted.make({})])

    bridge.push(pushed)
    await act(async () => void seed.resolve(logOf([0, HostStarting.make({})])))

    expect(screen.getByText('Host started')).toBeDefined()
  })

  it('shows pushed steps when asking main for the log so far fails', async () => {
    const seed = pendingSeed()
    const bridge = installBridge(seed.promise)
    render(<StartupStream />)
    await act(
      async () => void seed.reject(new Error('No handler registered for dia:getStartupLog'))
    )

    bridge.push(logOf([0, HostStarting.make({})]))

    expect(screen.getAllByText('Starting the Host').length).toBeGreaterThan(0)
  })

  it('marks a failed plugin in error red and shows its message', async () => {
    installBridge(
      Promise.resolve(
        logOf(
          [0, HostStarting.make({})],
          [100, EagerPluginLoadStarted.make({ name: 'dia-runs' })],
          [
            750,
            EagerPluginLoadSettled.make({
              name: 'dia-runs',
              outcome: PluginFailed.make({ message: 'Plugin setup timed out after 10s' })
            })
          ]
        )
      )
    )

    render(<StartupStream />)

    expect((await screen.findByText('failed')).className).toContain('text-error')
    expect(screen.getByText('Plugin setup timed out after 10s')).toBeDefined()
  })

  it('announces the plugin startup waits on, and shows its elapsed time outside the announcement', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(LAUNCH + 2050 + 6200)
    installBridge(
      Promise.resolve(
        logOf(
          [0, HostStarting.make({})],
          [2050, EagerPluginLoadStarted.make({ name: 'dia-tools' })]
        )
      )
    )

    render(<StartupStream />)

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Waiting on dia-tools'))
    expect(screen.getByText('6.2s').getAttribute('aria-hidden')).toBe('true')
  })
})
