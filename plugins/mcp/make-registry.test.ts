import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Ref, Scope, Stream } from 'effect'
import { makeRegistry } from './make-registry'
import { McpServerNameTaken, PluginSource, UserSource } from './registry'
import type { McpServer } from './servers'

const GITHUB: McpServer = { type: 'http', url: 'https://api.github.com/mcp', headers: {} }
const LINEAR: McpServer = { type: 'sse', url: 'https://mcp.linear.app/sse', headers: {} }
const JIRA: McpServer = { type: 'stdio', command: 'jira-mcp', args: [], env: {} }

const namesAndSources = (list: ReadonlyArray<{ name: string; source: unknown }>) =>
  list.map(({ name, source }) => ({ name, source }))

describe('makeRegistry', () => {
  it.effect('lists a registered server under the plugin that registered it', () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry
      const scope = yield* Scope.make()

      yield* registry.register('github', GITHUB, 'gh-tools').pipe(Scope.provide(scope))

      assert.deepStrictEqual(yield* registry.list, [
        { name: 'github', server: GITHUB, source: PluginSource.make({ plugin: 'gh-tools' }) }
      ])
    })
  )

  it.effect("removes a registered server when the registration's scope closes", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry
      const scope = yield* Scope.make()
      yield* registry.register('github', GITHUB, 'gh-tools').pipe(Scope.provide(scope))

      yield* Scope.close(scope, Exit.void)

      assert.deepStrictEqual(yield* registry.list, [])
    })
  )

  it.effect('refuses a second plugin the name the first holds and keeps the first', () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry
      const scope = yield* Scope.make()
      yield* registry.register('github', GITHUB, 'gh-tools').pipe(Scope.provide(scope))

      const refused = yield* registry
        .register('github', LINEAR, 'other-tools')
        .pipe(Scope.provide(scope), Effect.flip)

      assert.deepStrictEqual(
        [refused, namesAndSources(yield* registry.list)],
        [
          new McpServerNameTaken({
            name: 'github',
            holder: PluginSource.make({ plugin: 'gh-tools' })
          }),
          [{ name: 'github', source: PluginSource.make({ plugin: 'gh-tools' }) }]
        ]
      )
    })
  )

  it.effect('refuses a plugin a name the user holds, naming the user as holder', () =>
    Effect.gen(function* () {
      const { registry, replaceUser } = yield* makeRegistry
      yield* replaceUser({ github: GITHUB }, Effect.void)

      const refused = yield* registry
        .register('github', LINEAR, 'gh-tools')
        .pipe(Scope.provide(yield* Scope.make()), Effect.flip)

      assert.deepStrictEqual(
        refused,
        new McpServerNameTaken({ name: 'github', holder: UserSource.make({}) })
      )
    })
  )

  it.effect("a refused registration's scope closing does not remove the holder's server", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry
      yield* registry
        .register('github', GITHUB, 'gh-tools')
        .pipe(Scope.provide(yield* Scope.make()))
      const refusedScope = yield* Scope.make()
      yield* registry
        .register('github', LINEAR, 'other-tools')
        .pipe(Scope.provide(refusedScope), Effect.ignore)

      yield* Scope.close(refusedScope, Exit.void)

      assert.deepStrictEqual(namesAndSources(yield* registry.list), [
        { name: 'github', source: PluginSource.make({ plugin: 'gh-tools' }) }
      ])
    })
  )

  it.effect("replaces the user's servers and keeps every plugin's server", () =>
    Effect.gen(function* () {
      const { registry, replaceUser } = yield* makeRegistry
      yield* registry
        .register('linear', LINEAR, 'gh-tools')
        .pipe(Scope.provide(yield* Scope.make()))
      yield* replaceUser({ github: GITHUB, jira: JIRA }, Effect.void)

      yield* replaceUser({ github: GITHUB }, Effect.void)

      assert.deepStrictEqual(namesAndSources(yield* registry.list), [
        { name: 'github', source: UserSource.make({}) },
        { name: 'linear', source: PluginSource.make({ plugin: 'gh-tools' }) }
      ])
    })
  )

  it.effect("refuses a user save that uses a plugin's name without persisting or changing it", () =>
    Effect.gen(function* () {
      const { registry, replaceUser } = yield* makeRegistry
      yield* registry
        .register('linear', LINEAR, 'gh-tools')
        .pipe(Scope.provide(yield* Scope.make()))
      yield* replaceUser({ jira: JIRA }, Effect.void)
      const persisted = yield* Ref.make(false)

      const refused = yield* replaceUser(
        { github: GITHUB, linear: LINEAR },
        Ref.set(persisted, true)
      ).pipe(Effect.flip)

      assert.deepStrictEqual(
        [refused, yield* Ref.get(persisted), namesAndSources(yield* registry.list)],
        [
          new McpServerNameTaken({
            name: 'linear',
            holder: PluginSource.make({ plugin: 'gh-tools' })
          }),
          false,
          [
            { name: 'jira', source: UserSource.make({}) },
            { name: 'linear', source: PluginSource.make({ plugin: 'gh-tools' }) }
          ]
        ]
      )
    })
  )

  it.effect("leaves the user's servers unchanged when persisting fails", () =>
    Effect.gen(function* () {
      const { registry, replaceUser } = yield* makeRegistry
      yield* replaceUser({ jira: JIRA }, Effect.void)

      const exit = yield* replaceUser({ github: GITHUB }, Effect.die('disk full')).pipe(Effect.exit)

      assert.deepStrictEqual(
        [Exit.isFailure(exit), namesAndSources(yield* registry.list)],
        [true, [{ name: 'jira', source: UserSource.make({}) }]]
      )
    })
  )

  it.effect('lists servers ordered by name, whatever order they were added in', () =>
    Effect.gen(function* () {
      const { registry, replaceUser } = yield* makeRegistry
      yield* replaceUser({ linear: LINEAR }, Effect.void)
      yield* registry.register('jira', JIRA, 'atlassian').pipe(Scope.provide(yield* Scope.make()))
      yield* registry
        .register('github', GITHUB, 'gh-tools')
        .pipe(Scope.provide(yield* Scope.make()))

      assert.deepStrictEqual(
        (yield* registry.list).map(({ name }) => name),
        ['github', 'jira', 'linear']
      )
    })
  )

  it.effect('changes emits the current list first, then the list after a change', () =>
    Effect.gen(function* () {
      const { registry, replaceUser } = yield* makeRegistry
      yield* replaceUser({ jira: JIRA }, Effect.void)
      const scope = yield* Scope.make()

      const collecting = yield* registry.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Effect.yieldNow
      yield* registry.register('github', GITHUB, 'gh-tools').pipe(Scope.provide(scope))
      const lists = yield* Fiber.join(collecting)

      assert.deepStrictEqual(
        Array.from(lists, (list) => list.map(({ name }) => name)),
        [['jira'], ['github', 'jira']]
      )
    })
  )
})
