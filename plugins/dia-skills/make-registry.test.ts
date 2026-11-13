import { assert, describe, it } from '@effect/vitest'
import { Duration, Effect, Exit, Fiber, Option, Scope, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { makeRegistry } from './make-registry'
import { type Skill, type SkillSource, SkillSourceIdTaken } from './registry'

const NO_PROJECT = { cwd: Option.none<string>() }

const review: Skill = { name: 'review', description: 'Reviews a diff', group: 'Your skills' }
const plan: Skill = { name: 'dia-meta:plan', description: 'Plans work', group: 'Meta repo' }
const deploy: Skill = { name: 'deploy', description: '', group: 'Your skills' }

const fixed = (
  id: string,
  skills: ReadonlyArray<Skill>,
  pluginPath: Option.Option<string> = Option.none()
): SkillSource => ({
  id,
  pluginPath,
  skills: () => Stream.make(skills)
})

const current = (registry: {
  skills: (context: typeof NO_PROJECT) => Stream.Stream<ReadonlyArray<Skill>>
}) =>
  registry.skills(NO_PROJECT).pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrThrow))

describe('makeRegistry', () => {
  it.effect('lists no skill when no source is registered', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry

      assert.deepStrictEqual(yield* current(registry), [])
    })
  )

  it.effect("lists every source's skills sorted by group, then name", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry
      const scope = yield* Scope.make()
      yield* registry.register(fixed('user', [review, deploy])).pipe(Scope.provide(scope))
      yield* registry.register(fixed('meta', [plan])).pipe(Scope.provide(scope))

      assert.deepStrictEqual(yield* current(registry), [plan, deploy, review])
    })
  )

  it.effect('refuses a second source with an id already registered and keeps the first', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry
      const scope = yield* Scope.make()
      yield* registry.register(fixed('user', [review])).pipe(Scope.provide(scope))

      const refused = yield* registry
        .register(fixed('user', [deploy]))
        .pipe(Scope.provide(scope), Effect.flip)

      assert.deepStrictEqual(
        [refused, yield* current(registry)],
        [new SkillSourceIdTaken({ id: 'user' }), [review]]
      )
    })
  )

  it.effect("drops a source's skills when its registration scope closes", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry
      const scope = yield* Scope.make()
      yield* registry.register(fixed('user', [review])).pipe(Scope.provide(scope))

      yield* Scope.close(scope, Exit.void)

      assert.deepStrictEqual(yield* current(registry), [])
    })
  )

  it.effect("a refused registration's scope closing keeps the holder's skills", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry
      yield* registry.register(fixed('user', [review])).pipe(Scope.provide(yield* Scope.make()))
      const refusedScope = yield* Scope.make()
      yield* registry
        .register(fixed('user', [deploy]))
        .pipe(Scope.provide(refusedScope), Effect.flip)

      yield* Scope.close(refusedScope, Exit.void)

      assert.deepStrictEqual(yield* current(registry), [review])
    })
  )

  it.effect('registers an id again after the earlier registration closed', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry
      const first = yield* Scope.make()
      yield* registry.register(fixed('meta', [plan])).pipe(Scope.provide(first))
      yield* Scope.close(first, Exit.void)

      yield* registry.register(fixed('meta', [plan])).pipe(Scope.provide(yield* Scope.make()))

      assert.deepStrictEqual(yield* current(registry), [plan])
    })
  )

  it.effect('does not repeat a list equal to the one before it', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry
      const repeating: SkillSource = {
        id: 'user',
        pluginPath: Option.none(),
        skills: () => Stream.make([review], [{ ...review }], [deploy])
      }
      yield* registry.register(repeating).pipe(Scope.provide(yield* Scope.make()))

      const emitted = yield* registry.skills(NO_PROJECT).pipe(Stream.take(2), Stream.runCollect)

      assert.deepStrictEqual(emitted, [[review], [deploy]])
    })
  )

  it.effect('passes the context to each source', () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry
      const project: SkillSource = {
        id: 'project',
        pluginPath: Option.none(),
        skills: (context) =>
          Stream.make(
            Option.match(context.cwd, {
              onNone: () => [],
              onSome: (cwd) => [{ name: cwd, description: '', group: 'Project' }]
            })
          )
      }
      yield* registry.register(project).pipe(Scope.provide(yield* Scope.make()))

      const listed = yield* registry
        .skills({ cwd: Option.some('F:/Dev/dia') })
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

      assert.deepStrictEqual(listed, [{ name: 'F:/Dev/dia', description: '', group: 'Project' }])
    })
  )

  describe('resolve', () => {
    const META_PLUGIN = 'C:/Users/me/AppData/Roaming/dia/plugins/dia-meta/repo/plugin'

    it.effect("returns a plugin source's directory for a name it lists, and no missing name", () =>
      Effect.gen(function* () {
        const registry = yield* makeRegistry
        const scope = yield* Scope.make()
        yield* registry.register(fixed('user', [review])).pipe(Scope.provide(scope))
        yield* registry
          .register(fixed('meta', [plan], Option.some(META_PLUGIN)))
          .pipe(Scope.provide(scope))

        const resolution = yield* registry.resolve(['dia-meta:plan', 'review'], NO_PROJECT)

        assert.deepStrictEqual(resolution, Option.some({ missing: [], pluginPaths: [META_PLUGIN] }))
      })
    )

    it.effect('loads no plugin directory when no named skill comes from that source', () =>
      Effect.gen(function* () {
        const registry = yield* makeRegistry
        const scope = yield* Scope.make()
        yield* registry.register(fixed('user', [review])).pipe(Scope.provide(scope))
        yield* registry
          .register(fixed('meta', [plan], Option.some(META_PLUGIN)))
          .pipe(Scope.provide(scope))

        const resolution = yield* registry.resolve(['review'], NO_PROJECT)

        assert.deepStrictEqual(resolution, Option.some({ missing: [], pluginPaths: [] }))
      })
    )

    it.effect('lists each name no source has as missing', () =>
      Effect.gen(function* () {
        const registry = yield* makeRegistry
        yield* registry.register(fixed('user', [review])).pipe(Scope.provide(yield* Scope.make()))

        const resolution = yield* registry.resolve(
          ['review', 'deploy', 'dia-meta:plan'],
          NO_PROJECT
        )

        assert.deepStrictEqual(
          resolution,
          Option.some({ missing: ['deploy', 'dia-meta:plan'], pluginPaths: [] })
        )
      })
    )

    it.effect('resolves nothing while no source is registered', () =>
      Effect.gen(function* () {
        const registry = yield* makeRegistry

        assert.deepStrictEqual(yield* registry.resolve(['review'], NO_PROJECT), Option.none())
      })
    )

    it.effect('resolves nothing when a source has not listed its skills within 2 seconds', () =>
      Effect.gen(function* () {
        const registry = yield* makeRegistry
        const silent: SkillSource = {
          id: 'slow',
          pluginPath: Option.none(),
          skills: () => Stream.never
        }
        yield* registry.register(silent).pipe(Scope.provide(yield* Scope.make()))

        const resolving = yield* registry.resolve(['review'], NO_PROJECT).pipe(Effect.forkChild)
        yield* TestClock.adjust(Duration.seconds(2))

        assert.deepStrictEqual(yield* Fiber.join(resolving), Option.none())
      })
    )

    it.effect('resolves against the context it is given', () =>
      Effect.gen(function* () {
        const registry = yield* makeRegistry
        const project: SkillSource = {
          id: 'project',
          pluginPath: Option.none(),
          skills: (context) => Stream.make(Option.isSome(context.cwd) ? [deploy] : [])
        }
        yield* registry.register(project).pipe(Scope.provide(yield* Scope.make()))

        assert.deepStrictEqual(
          yield* registry.resolve(['deploy'], { cwd: Option.some('F:/Dev/dia') }),
          Option.some({ missing: [], pluginPaths: [] })
        )
        assert.deepStrictEqual(
          yield* registry.resolve(['deploy'], NO_PROJECT),
          Option.some({ missing: ['deploy'], pluginPaths: [] })
        )
      })
    )
  })
})
