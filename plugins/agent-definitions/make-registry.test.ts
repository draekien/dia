import { NodeFileSystem, NodePath } from '@effect/platform-node'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Fiber, FileSystem, Layer, Path, Schema, Scope, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { makeRegistry } from './make-registry'
import {
  AgentDefinition,
  AgentDefinitionId,
  AgentDefinitionIdTaken,
  AgentDefinitionName,
  AgentDefinitionNameTaken,
  AgentDefinitionNotFound,
  ContributedDefinitionDeleted,
  ContributedDefinitionRenamed,
  PluginSource,
  UserSource
} from './registry'
import { agentDefinitionMigrations } from './store'

const definition = (id: string, name: string, jobDescription = 'default'): AgentDefinition => ({
  id: AgentDefinitionId.make(id),
  name: AgentDefinitionName.make(name),
  jobDescription,
  skills: [],
  permissions: { allow: [], ask: [], deny: [] },
  mcpServers: [],
  bypassOptIn: false,
  model: null,
  thinkingLevel: 'medium'
})

const fieldsOf = ({ id: _id, ...fields }: AgentDefinition) => fields

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'
const ID_D = '44444444-4444-4444-8444-444444444444'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)

const inMemory = Effect.gen(function* () {
  const scope = yield* Scope.make()
  const sql = yield* openDatabase(':memory:', agentDefinitionMigrations).pipe(Scope.provide(scope))
  const open = makeRegistry.pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.provide(NodeCrypto.layer)
  )
  return { open, close: Scope.close(scope, Exit.void) }
})

const contribute = (
  registry: Effect.Success<typeof makeRegistry>,
  scope: Scope.Scope,
  def: AgentDefinition,
  plugin = 'org'
) => registry.register(def, plugin).pipe(Scope.provide(scope))

describe('agent definition registry', () => {
  it.effect(
    'lists contributed definitions first in registration order, then user ones by name',
    () =>
      Effect.gen(function* () {
        const { open } = yield* inMemory
        const registry = yield* open
        const scope = yield* Scope.make()
        yield* contribute(registry, scope, definition(ID_B, 'Zed'))
        yield* contribute(registry, scope, definition(ID_A, 'Alpha'))
        yield* registry.create(fieldsOf(definition(ID_C, 'Yak')))
        yield* registry.create(fieldsOf(definition(ID_C, 'Bee')))

        const names = (yield* registry.list).map((entry) => entry.definition.name)

        assert.deepStrictEqual(names, ['Zed', 'Alpha', 'Bee', 'Yak'])
      })
  )

  it.effect('tags each listed definition with its source', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      yield* contribute(registry, yield* Scope.make(), definition(ID_A, 'Alpha'), 'org')
      yield* registry.create(fieldsOf(definition(ID_B, 'Bee')))

      const sources = (yield* registry.list).map((entry) => [entry.source, entry.edited])

      assert.deepStrictEqual(sources, [
        [PluginSource.make({ plugin: 'org' }), false],
        [UserSource.make({}), false]
      ])
    })
  )

  it.effect('create returns a fresh id each time and lists the definition under it', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      const fields = fieldsOf(definition(ID_A, 'One'))

      const first = yield* registry.create(fields)
      const second = yield* registry.create({ ...fields, name: AgentDefinitionName.make('Two') })

      assert.notStrictEqual(first.id, second.id)
      assert.notStrictEqual(first.id, ID_A)
      assert.deepStrictEqual(fieldsOf(first), fields)
      assert.deepStrictEqual(
        (yield* registry.list).map((entry) => entry.definition.id),
        [first.id, second.id]
      )
    })
  )

  it.effect('refuses a create whose name differs from a listed one only in ASCII case', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      yield* contribute(registry, yield* Scope.make(), definition(ID_A, 'Reviewer'))

      const refused = yield* registry
        .create(fieldsOf(definition(ID_B, 'rEVIEWER')))
        .pipe(Effect.flip)

      assert.deepStrictEqual(refused, new AgentDefinitionNameTaken({ name: 'rEVIEWER' as never }))
      assert.lengthOf(yield* registry.list, 1)
    })
  )

  it.effect('does not fold non-ASCII case when comparing names', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      yield* registry.create(fieldsOf(definition(ID_A, 'Élan')))

      yield* registry.create(fieldsOf(definition(ID_B, 'élan')))

      assert.lengthOf(yield* registry.list, 2)
    })
  )

  it.effect('register refuses an id a user definition holds', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      const created = yield* registry.create(fieldsOf(definition(ID_A, 'Mine')))

      const refused = yield* contribute(
        registry,
        yield* Scope.make(),
        definition(created.id, 'Other')
      ).pipe(Effect.flip)

      assert.deepStrictEqual(refused, new AgentDefinitionIdTaken({ id: created.id }))
    })
  )

  it.effect('register refuses an id another contribution holds and keeps the first', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      const scope = yield* Scope.make()
      yield* contribute(registry, scope, definition(ID_A, 'First'))

      const refused = yield* contribute(registry, scope, definition(ID_A, 'Second')).pipe(
        Effect.flip
      )

      assert.deepStrictEqual(refused, new AgentDefinitionIdTaken({ id: ID_A as never }))
      assert.deepStrictEqual(
        (yield* registry.list).map((entry) => entry.definition.name),
        ['First']
      )
    })
  )

  it.effect(
    'register refuses a name a user definition holds, ignoring ASCII case, and keeps the user one',
    () =>
      Effect.gen(function* () {
        const { open } = yield* inMemory
        const registry = yield* open
        yield* registry.create(fieldsOf(definition(ID_A, 'Planner')))

        const refused = yield* contribute(
          registry,
          yield* Scope.make(),
          definition(ID_B, 'PLANNER')
        ).pipe(Effect.flip)

        assert.deepStrictEqual(refused, new AgentDefinitionNameTaken({ name: 'PLANNER' as never }))
        assert.deepStrictEqual(
          (yield* registry.list).map((entry) => entry.source._tag),
          ['User']
        )
      })
  )

  it.effect('register refuses a name another contribution holds', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      const scope = yield* Scope.make()
      yield* contribute(registry, scope, definition(ID_A, 'Planner'))

      const refused = yield* contribute(registry, scope, definition(ID_B, 'planner')).pipe(
        Effect.flip
      )

      assert.strictEqual(refused._tag, 'AgentDefinitionNameTaken')
    })
  )

  it.effect("removes a contributed definition when the registration's scope closes", () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      const scope = yield* Scope.make()
      yield* contribute(registry, scope, definition(ID_A, 'Alpha'))

      yield* Scope.close(scope, Exit.void)

      assert.deepStrictEqual(yield* registry.list, [])
    })
  )

  it.effect('edits a user definition and lists the change', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      const created = yield* registry.create(fieldsOf(definition(ID_A, 'Mine', 'before')))

      const edited = yield* registry.edit(created.id, { jobDescription: 'after' })

      assert.deepStrictEqual(edited, { ...created, jobDescription: 'after' })
      assert.deepStrictEqual(
        (yield* registry.list).map((entry) => entry.definition),
        [edited]
      )
    })
  )

  it.effect('edit applies an absent field as unchanged', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      const created = yield* registry.create(fieldsOf(definition(ID_A, 'Mine', 'keep')))

      const edited = yield* registry.edit(created.id, { bypassOptIn: true })

      assert.deepStrictEqual(edited, { ...created, bypassOptIn: true })
    })
  )

  it.effect('edit allows keeping the definition its own name in a different case', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      const created = yield* registry.create(fieldsOf(definition(ID_A, 'mine')))

      const edited = yield* registry.edit(created.id, { name: AgentDefinitionName.make('MINE') })

      assert.strictEqual(edited.name, 'MINE')
    })
  )

  it.effect('edit refuses a name another listed definition holds', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      yield* registry.create(fieldsOf(definition(ID_A, 'Taken')))
      const other = yield* registry.create(fieldsOf(definition(ID_B, 'Other')))

      const refused = yield* registry
        .edit(other.id, { name: AgentDefinitionName.make('tAKEN') })
        .pipe(Effect.flip)

      assert.strictEqual(refused._tag, 'AgentDefinitionNameTaken')
    })
  )

  it.effect('edit of an unknown id fails with AgentDefinitionNotFound', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open

      const refused = yield* registry
        .edit(AgentDefinitionId.make(ID_D), { jobDescription: 'x' })
        .pipe(Effect.flip)

      assert.deepStrictEqual(refused, new AgentDefinitionNotFound({ id: ID_D as never }))
    })
  )

  it.effect(
    'editing a contributed definition lists the override fields with its own id and name and edited true',
    () =>
      Effect.gen(function* () {
        const { open } = yield* inMemory
        const registry = yield* open
        yield* contribute(registry, yield* Scope.make(), definition(ID_A, 'Alpha', 'default'))

        yield* registry.edit(AgentDefinitionId.make(ID_A), {
          jobDescription: 'mine',
          skills: ['s']
        })

        const [entry] = yield* registry.list
        assert.deepStrictEqual(
          [entry?.definition, entry?.source, entry?.edited],
          [
            { ...definition(ID_A, 'Alpha', 'mine'), skills: ['s'] },
            PluginSource.make({ plugin: 'org' }),
            true
          ]
        )
      })
  )

  it.effect(
    'editing a contributed definition with its own name succeeds; a different name fails',
    () =>
      Effect.gen(function* () {
        const { open } = yield* inMemory
        const registry = yield* open
        yield* contribute(registry, yield* Scope.make(), definition(ID_A, 'Alpha'))

        const same = yield* registry.edit(AgentDefinitionId.make(ID_A), {
          name: AgentDefinitionName.make('Alpha')
        })
        const renamed = yield* registry
          .edit(AgentDefinitionId.make(ID_A), { name: AgentDefinitionName.make('Beta') })
          .pipe(Effect.flip)

        assert.strictEqual(same.name, 'Alpha')
        assert.deepStrictEqual(renamed, new ContributedDefinitionRenamed({ id: ID_A as never }))
        assert.strictEqual((yield* registry.list)[0]?.definition.name, 'Alpha')
      })
  )

  it.effect(
    'a contributed definition keeps its override after a new registry opens the same database (success criterion 8)',
    () =>
      Effect.gen(function* () {
        const { open } = yield* inMemory
        const first = yield* open
        yield* contribute(first, yield* Scope.make(), definition(ID_A, 'Alpha'))
        yield* first.edit(AgentDefinitionId.make(ID_A), { jobDescription: 'edited' })

        const second = yield* open
        yield* contribute(second, yield* Scope.make(), definition(ID_A, 'Alpha'))

        const [entry] = yield* second.list
        assert.deepStrictEqual(
          [entry?.definition.name, entry?.definition.jobDescription, entry?.edited],
          ['Alpha', 'edited', true]
        )
      })
  )

  it.effect('keeps user definitions across a restart on a file-backed database', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const filename = path.join(yield* fs.makeTempDirectoryScoped(), 'data.db')
      const run = <A, E>(
        use: (registry: Effect.Success<typeof makeRegistry>) => Effect.Effect<A, E>
      ) =>
        Effect.gen(function* () {
          const sql = yield* openDatabase(filename, agentDefinitionMigrations)
          const registry = yield* makeRegistry.pipe(Effect.provideService(SqlClient.SqlClient, sql))
          return yield* use(registry)
        }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer))
      const created = yield* run((registry) =>
        registry.create(fieldsOf(definition(ID_A, 'Persisted')))
      )

      const listed = yield* run((registry) => registry.list)

      assert.deepStrictEqual(
        listed.map((entry) => entry.definition),
        [created]
      )
    }).pipe(Effect.scoped, Effect.provide(platform))
  )

  it.effect(
    'does not list an override whose contributor is gone, and lists it again when re-registered',
    () =>
      Effect.gen(function* () {
        const { open } = yield* inMemory
        const registry = yield* open
        const scope = yield* Scope.make()
        yield* contribute(registry, scope, definition(ID_A, 'Alpha'))
        yield* registry.edit(AgentDefinitionId.make(ID_A), { jobDescription: 'edited' })

        yield* Scope.close(scope, Exit.void)
        const whileGone = yield* registry.list
        yield* contribute(registry, yield* Scope.make(), definition(ID_A, 'Alpha'))
        const [back] = yield* registry.list

        assert.deepStrictEqual(whileGone, [])
        assert.deepStrictEqual([back?.definition.jobDescription, back?.edited], ['edited', true])
      })
  )

  it.effect(
    'a name freed by a gone contributor can be created, an override of it stays unlisted',
    () =>
      Effect.gen(function* () {
        const { open } = yield* inMemory
        const registry = yield* open
        const scope = yield* Scope.make()
        yield* contribute(registry, scope, definition(ID_A, 'Alpha'))
        yield* registry.edit(AgentDefinitionId.make(ID_A), { jobDescription: 'edited' })
        yield* Scope.close(scope, Exit.void)

        yield* registry.create(fieldsOf(definition(ID_B, 'Alpha')))

        assert.deepStrictEqual(
          (yield* registry.list).map((entry) => entry.source._tag),
          ['User']
        )
      })
  )

  it.effect('a user definition stays listed when a contribution later takes its name', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      yield* registry.create(fieldsOf(definition(ID_A, 'Shared')))

      const refused = yield* contribute(
        registry,
        yield* Scope.make(),
        definition(ID_B, 'Shared')
      ).pipe(Effect.flip)

      assert.strictEqual(refused._tag, 'AgentDefinitionNameTaken')
      assert.deepStrictEqual(
        (yield* registry.list).map((entry) => entry.source._tag),
        ['User']
      )
    })
  )

  it.effect('deletes a user definition so it is no longer listed or stored', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      const created = yield* registry.create(fieldsOf(definition(ID_A, 'Mine')))

      yield* registry.delete(created.id)

      assert.deepStrictEqual(yield* registry.list, [])
      assert.deepStrictEqual(yield* (yield* open).list, [])
    })
  )

  it.effect('delete of a contributed id fails with ContributedDefinitionDeleted and keeps it', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      yield* contribute(registry, yield* Scope.make(), definition(ID_A, 'Alpha'))

      const refused = yield* registry.delete(AgentDefinitionId.make(ID_A)).pipe(Effect.flip)

      assert.deepStrictEqual(refused, new ContributedDefinitionDeleted({ id: ID_A as never }))
      assert.lengthOf(yield* registry.list, 1)
    })
  )

  it.effect('delete of an unknown id fails with AgentDefinitionNotFound', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open

      const refused = yield* registry.delete(AgentDefinitionId.make(ID_D)).pipe(Effect.flip)

      assert.deepStrictEqual(refused, new AgentDefinitionNotFound({ id: ID_D as never }))
    })
  )

  it.effect('importDefinitions stores user definitions under their ids and is idempotent', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      const offered = [definition(ID_A, 'One'), definition(ID_B, 'Two')]

      yield* registry.importDefinitions(offered)
      yield* registry.importDefinitions(offered)

      assert.deepStrictEqual(
        (yield* registry.list).map((entry) => entry.definition),
        offered
      )
      assert.deepStrictEqual(
        (yield* (yield* open).list).map((entry) => entry.definition),
        offered
      )
    })
  )

  it.effect('importDefinitions skips an id already stored without overwriting it', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      yield* registry.importDefinitions([definition(ID_A, 'One', 'first')])

      yield* registry.importDefinitions([definition(ID_A, 'One', 'second')])

      assert.strictEqual((yield* registry.list)[0]?.definition.jobDescription, 'first')
    })
  )

  it.effect('importDefinitions skips a name collision and still imports the rest', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      yield* contribute(registry, yield* Scope.make(), definition(ID_A, 'Taken'))

      yield* registry.importDefinitions([definition(ID_B, 'taken'), definition(ID_C, 'Free')])

      assert.deepStrictEqual(
        (yield* registry.list).map((entry) => entry.definition.name),
        ['Taken', 'Free']
      )
    })
  )

  it.effect('importDefinitions skips an id a plugin contributes', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      yield* contribute(registry, yield* Scope.make(), definition(ID_A, 'Contributed'))

      yield* registry.importDefinitions([definition(ID_A, 'Imported')])

      assert.deepStrictEqual(
        (yield* registry.list).map((entry) => entry.definition.name),
        ['Contributed']
      )
    })
  )

  it.effect(
    'importOverrides edits the contributed definition with the same id once and is idempotent',
    () =>
      Effect.gen(function* () {
        const { open } = yield* inMemory
        const registry = yield* open
        yield* contribute(registry, yield* Scope.make(), definition(ID_A, 'Alpha', 'default'))

        yield* registry.importOverrides([definition(ID_A, 'Alpha', 'imported')])
        yield* registry.importOverrides([definition(ID_A, 'Alpha', 'again')])

        const [entry] = yield* registry.list
        assert.deepStrictEqual(
          [(yield* registry.list).length, entry?.definition.jobDescription, entry?.edited],
          [1, 'imported', true]
        )
      })
  )

  it.effect('importOverrides of an id nobody contributes is stored but not listed', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open

      yield* registry.importOverrides([definition(ID_A, 'Ghost')])

      assert.deepStrictEqual(yield* registry.list, [])
    })
  )

  it.effect('changes emits the current list, then again after each change', () =>
    Effect.gen(function* () {
      const { open } = yield* inMemory
      const registry = yield* open
      const sizes: Array<number> = []
      const fiber = yield* registry.changes.pipe(
        Stream.runForEach((list) => Effect.sync(() => sizes.push(list.length))),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      yield* registry.create(fieldsOf(definition(ID_A, 'One')))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)

      assert.deepStrictEqual(sizes, [0, 1])
    })
  )
})

describe('AgentDefinition schema', () => {
  it('rejects a name over 40 characters and accepts exactly 40', () => {
    const decode = Schema.decodeUnknownExit(AgentDefinitionName)

    assert.deepStrictEqual(
      [decode('a'.repeat(40))._tag, decode('a'.repeat(41))._tag, decode('')._tag],
      ['Success', 'Failure', 'Failure']
    )
  })

  it('decodes a stored definition JSON round trip', () => {
    const def = definition(ID_A, 'Alpha')

    assert.deepStrictEqual(
      Schema.decodeUnknownSync(Schema.fromJsonString(AgentDefinition))(
        Schema.encodeSync(Schema.fromJsonString(AgentDefinition))(def)
      ),
      def
    )
  })
})
