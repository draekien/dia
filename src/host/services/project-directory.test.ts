import { NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Path } from 'effect'
import { directoryKey } from './project-directory'

describe('directoryKey', () => {
  it.effect('gives a path with a trailing separator the same key as without', () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const directory = path.resolve('repo')

      const withSeparator = yield* directoryKey(`${directory}${path.sep}`)

      assert.strictEqual(withSeparator, yield* directoryKey(directory))
    }).pipe(Effect.provide(NodePath.layer))
  )

  it.effect('gives a relative path the key of its absolute path', () =>
    Effect.gen(function* () {
      const path = yield* Path.Path

      const relative = yield* directoryKey('repo')

      assert.strictEqual(relative, yield* directoryKey(path.resolve('repo')))
    }).pipe(Effect.provide(NodePath.layer))
  )

  it.effect.skipIf(process.platform !== 'win32')(
    'gives two spellings of one Windows directory the same key',
    () =>
      Effect.gen(function* () {
        const upper = yield* directoryKey('F:\\Dev\\Dia')

        assert.strictEqual(upper, yield* directoryKey('f:/dev/dia'))
      }).pipe(Effect.provide(NodePath.layer))
  )
})
