import {
  EagerPluginLoadSettled,
  EagerPluginLoadStarted,
  EagerPluginsSettled,
  EagerPluginsStarting,
  HostReadyReached,
  HostServicesStarting,
  HostStarted,
  HostStarting,
  type StartupEvent,
  type StartupLog,
  StartupSkipped
} from '@shared/domain/startup'
import { PluginFailed, PluginLoaded, PluginWaiting } from '@shared/plugin/manifest'
import { describe, expect, it } from 'vitest'
import { describeStartup, type StartupLine } from './startup-lines'

const LAUNCH = 1_700_000_000_000

const logOf = (...steps: ReadonlyArray<readonly [number, StartupEvent]>): StartupLog =>
  steps.map(([afterMillis, event]) => ({ atMillis: LAUNCH + afterMillis, event }))

const textOf = (line: StartupLine): string =>
  line._tag === 'HostStep'
    ? line.text
    : [line.plugin, line.verb, line.durationMillis, line.detail]
        .filter((part) => part !== undefined)
        .join(' ')

describe('describeStartup', () => {
  it('says dia is starting, with no elapsed time, before main records a step', () => {
    const { lines, waiting } = describeStartup([])

    expect(lines).toEqual([])
    expect(waiting).toEqual({ label: 'Starting dia', sinceMillis: undefined })
  })

  it('lists the Host steps in order with their offset from the first step', () => {
    const log = logOf(
      [0, HostStarting.make({})],
      [310, HostStarted.make({})],
      [330, HostServicesStarting.make({})],
      [920, EagerPluginsStarting.make({ count: 4 })]
    )

    const { lines } = describeStartup(log)

    expect(lines.map((line) => [line.offsetMillis, textOf(line)])).toEqual([
      [0, 'Starting the Host'],
      [310, 'Host started'],
      [330, 'Starting Host services'],
      [920, 'Loading 4 eager plugins']
    ])
  })

  it.each([
    [0, 'No eager plugins'],
    [1, 'Loading 1 eager plugin'],
    [2, 'Loading 2 eager plugins']
  ])('words a count of %i eager plugins as "%s"', (count, expected) => {
    const log = logOf([0, HostStarting.make({})], [5, EagerPluginsStarting.make({ count })])

    expect(textOf(describeStartup(log).lines[1])).toBe(expected)
  })

  it('appends a loaded line with the time since that plugin started loading', () => {
    const log = logOf(
      [0, HostStarting.make({})],
      [920, EagerPluginLoadStarted.make({ name: 'dia-claude-code' })],
      [
        1400,
        EagerPluginLoadSettled.make({ name: 'dia-claude-code', outcome: PluginLoaded.make({}) })
      ]
    )

    const { lines } = describeStartup(log)

    expect(lines.slice(1).map(textOf)).toEqual([
      'dia-claude-code loading',
      'dia-claude-code loaded 480'
    ])
  })

  it('measures each duration from the same plugin, not the previous line', () => {
    const log = logOf(
      [0, HostStarting.make({})],
      [100, EagerPluginLoadStarted.make({ name: 'dia-runs' })],
      [700, EagerPluginLoadSettled.make({ name: 'dia-runs', outcome: PluginLoaded.make({}) })],
      [700, EagerPluginLoadStarted.make({ name: 'dia-tools' })],
      [2900, EagerPluginLoadSettled.make({ name: 'dia-tools', outcome: PluginLoaded.make({}) })]
    )

    const { lines } = describeStartup(log)

    expect(lines[4]).toMatchObject({ plugin: 'dia-tools', durationMillis: 2200 })
  })

  it('shows a failed plugin with its message', () => {
    const log = logOf(
      [0, HostStarting.make({})],
      [100, EagerPluginLoadStarted.make({ name: 'dia-runs' })],
      [
        10_100,
        EagerPluginLoadSettled.make({
          name: 'dia-runs',
          outcome: PluginFailed.make({ message: 'Plugin setup timed out after 10s' })
        })
      ]
    )

    expect(describeStartup(log).lines[2]).toMatchObject({
      verb: 'failed',
      durationMillis: 10_000,
      detail: 'Plugin setup timed out after 10s'
    })
  })

  it('shows a waiting plugin with the service keys it waits for', () => {
    const log = logOf(
      [0, HostStarting.make({})],
      [100, EagerPluginLoadStarted.make({ name: 'dia-org' })],
      [
        150,
        EagerPluginLoadSettled.make({
          name: 'dia-org',
          outcome: PluginWaiting.make({ missing: ['dia-runs/runs', 'dia-tools/registry'] })
        })
      ]
    )

    expect(describeStartup(log).lines[2]).toMatchObject({
      verb: 'waiting',
      detail: 'for dia-runs/runs, dia-tools/registry'
    })
  })

  it('shows a skipped plugin without a duration', () => {
    const log = logOf(
      [0, HostStarting.make({})],
      [100, EagerPluginLoadStarted.make({ name: 'dia-org' })],
      [101, EagerPluginLoadSettled.make({ name: 'dia-org', outcome: StartupSkipped.make({}) })]
    )

    const skipped = describeStartup(log).lines[2]

    expect(skipped).toMatchObject({ verb: 'skipped' })
    expect(skipped).not.toHaveProperty('durationMillis')
  })

  it('names the plugin being loaded as the one startup waits on, since its load began', () => {
    const log = logOf(
      [0, HostStarting.make({})],
      [2050, EagerPluginLoadStarted.make({ name: 'dia-tools' })]
    )

    expect(describeStartup(log).waiting).toEqual({
      label: 'Waiting on',
      plugin: 'dia-tools',
      sinceMillis: LAUNCH + 2050
    })
  })

  it.each([
    ['HostStarting', HostStarting.make({}), 'Starting the Host'],
    ['HostStarted', HostStarted.make({}), 'Starting Host services'],
    ['EagerPluginsSettled', EagerPluginsSettled.make({}), 'Waiting for the Host'],
    ['HostReadyReached', HostReadyReached.make({}), 'Loading the workspace']
  ])('after a %s step the pinned line names the step in progress', (_tag, event, label) => {
    const log = logOf([0, HostStarting.make({})], [40, event])

    expect(describeStartup(log).waiting.label).toBe(label)
  })
})
