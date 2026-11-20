import { assert, describe, it } from '@effect/vitest'
import {
  type PluginInfo,
  PluginLoaded,
  type PluginManifest,
  PluginOverrideApplied
} from '@shared/plugin/manifest'
import { PluginLoadError } from '@shared/plugin/plugin-registry'
import { Deferred, Effect, Fiber, Ref } from 'effect'
import { makePluginControl, type PluginControlHost } from './plugin-control'

const notes: PluginInfo = {
  name: 'notes',
  category: 'feature',
  origin: 'override',
  root: 'C:/meta/plugins/notes',
  status: PluginLoaded.make({}),
  memoryBytes: 0,
  provides: []
}

const host = (overrides: Partial<PluginControlHost> = {}): PluginControlHost => ({
  list: () => Effect.succeed([notes]),
  load: () => Effect.succeed(notes),
  peek: () => Effect.die('peek not expected'),
  setOverride: () => Effect.succeed(PluginOverrideApplied.make({})),
  ...overrides
})

describe('makePluginControl', () => {
  it.effect('inspect fails with PluginNotFound for a name the Host does not list', () =>
    Effect.gen(function* () {
      const control = makePluginControl(host())

      const error = yield* control.inspect('missing').pipe(Effect.flip)

      assert.strictEqual(error._tag, 'PluginNotFound')
      assert.strictEqual(error.plugin, 'missing')
    })
  )

  it.effect('inspect reads the manifest from the listed root and fills in absent fields', () =>
    Effect.gen(function* () {
      const peeked: Array<string> = []
      const manifest: PluginManifest = { name: 'notes', api: '0.0.47', category: 'feature' }
      const control = makePluginControl(
        host({
          peek: (_name, root) => Effect.sync(() => peeked.push(root)).pipe(Effect.as(manifest))
        })
      )

      const description = yield* control.inspect('notes')

      assert.deepStrictEqual(peeked, [notes.root])
      assert.deepStrictEqual(description, { info: notes, inject: [], exports: [], load: 'lazy' })
    })
  )

  it.effect('inspect passes the manifest fields through when they are present', () =>
    Effect.gen(function* () {
      const manifest: PluginManifest = {
        name: 'notes',
        api: '0.0.47',
        category: 'feature',
        inject: ['runs'],
        exports: ['calls.ts'],
        load: 'eager'
      }
      const control = makePluginControl(host({ peek: () => Effect.succeed(manifest) }))

      const description = yield* control.inspect('notes')

      assert.deepStrictEqual(description.inject, ['runs'])
      assert.deepStrictEqual(description.exports, ['calls.ts'])
      assert.strictEqual(description.load, 'eager')
    })
  )

  it.effect('inspect fails with PluginManifestUnreadable carrying the read error', () =>
    Effect.gen(function* () {
      const control = makePluginControl(
        host({ peek: () => Effect.fail(new PluginLoadError({ message: 'bad json' })) })
      )

      const error = yield* control.inspect('notes').pipe(Effect.flip)

      assert.strictEqual(error._tag, 'PluginManifestUnreadable')
      assert.strictEqual(error.message, 'bad json')
    })
  )

  it.effect('reload keeps running after the caller is interrupted', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const finished = yield* Ref.make(false)
      const control = makePluginControl(
        host({
          load: () =>
            Deferred.await(gate).pipe(Effect.andThen(Ref.set(finished, true)), Effect.as(notes))
        })
      )

      const caller = yield* Effect.forkChild(control.reload('notes'))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(caller)
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      assert.isTrue(yield* Ref.get(finished))
    })
  )
})
