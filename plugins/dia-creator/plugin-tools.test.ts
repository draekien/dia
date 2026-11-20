import { type PluginControl, PluginNotFound } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { makeCreatorTools } from './plugin-tools'

const SCOPE = { runId: 'run-1', labels: ['dia-creator'], context: undefined }

const plugins: PluginControl = {
  list: Effect.succeed([
    {
      name: 'clock',
      category: 'feature',
      origin: 'override',
      root: 'C:/trees/creator/plugins/clock',
      status: { _tag: 'Failed', message: 'SyntaxError in host.ts' },
      memoryBytes: 0,
      provides: []
    },
    {
      name: 'dia-chat',
      category: 'feature',
      origin: 'default',
      root: 'C:/app/plugins/dia-chat',
      status: { _tag: 'Loaded' },
      memoryBytes: 0,
      provides: []
    }
  ]),
  inspect: (name) => Effect.fail(new PluginNotFound({ plugin: name })),
  setOverride: () => Effect.die('not used'),
  reload: () => Effect.die('not used')
}

const tool = (name: string) => {
  const found = makeCreatorTools(plugins).find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`No tool ${name}`)
  return found
}

describe('makeCreatorTools', () => {
  it.effect('lists each plugin with status, origin and folder, and the failure under it', () =>
    Effect.gen(function* () {
      const result = yield* tool('plugin_list').run({}, SCOPE)

      assert.deepStrictEqual(result, {
        text: [
          'clock  Failed  override  C:/trees/creator/plugins/clock',
          '  SyntaxError in host.ts',
          'dia-chat  Loaded  default  C:/app/plugins/dia-chat'
        ].join('\n'),
        isError: false
      })
    })
  )

  it.effect('reports an unknown plugin name as an error', () =>
    Effect.gen(function* () {
      const result = yield* tool('plugin_inspect').run({ name: 'missing' }, SCOPE)

      assert.deepStrictEqual(result, { text: 'No plugin named missing', isError: true })
    })
  )
})
