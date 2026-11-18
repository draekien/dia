import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { type AgentDefinition, AgentDefinitionId, AgentDefinitionName } from './registry'
import { agentDefinitionMigrations, readDefinitions, saveDefinition } from './store'

const ID = '11111111-1111-4111-8111-111111111111'

const OLD_JSON = {
  id: ID,
  name: 'Release manager',
  jobDescription: 'Cuts releases.',
  skills: [],
  permissions: { allow: [], ask: [], deny: [] },
  mcpServers: [],
  bypassOptIn: false,
  model: 'claude-sonnet-5',
  thinkingLevel: 'high'
}

const withDatabase = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const sql = yield* openDatabase(':memory:', agentDefinitionMigrations)
    return yield* body.pipe(Effect.provideService(SqlClient.SqlClient, sql))
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer))

const insertRaw = (definition: unknown) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO definitions ${sql.insert({
      id: ID,
      override: 0,
      definition: JSON.stringify(definition)
    })}`
  })

describe('stored agent definitions', () => {
  it.effect('reads a definition stored with a model as a selection on dia-claude-code', () =>
    withDatabase(
      Effect.gen(function* () {
        yield* insertRaw(OLD_JSON)

        const [stored] = yield* readDefinitions

        assert.deepStrictEqual(stored?.definition.selection, {
          backend: 'dia-claude-code',
          model: 'claude-sonnet-5'
        })
      })
    )
  )

  it.effect('reads a definition stored with a null model as no selection', () =>
    withDatabase(
      Effect.gen(function* () {
        yield* insertRaw({ ...OLD_JSON, model: null })

        const [stored] = yield* readDefinitions

        assert.isNull(stored?.definition.selection)
      })
    )
  )

  it.effect('writes a definition with its selection and reads it back unchanged', () =>
    withDatabase(
      Effect.gen(function* () {
        const definition: AgentDefinition = {
          id: AgentDefinitionId.make(ID),
          name: AgentDefinitionName.make('Archivist'),
          jobDescription: '',
          skills: [],
          permissions: { allow: [], ask: [], deny: [] },
          mcpServers: [],
          bypassOptIn: false,
          selection: { backend: 'other-adapter', model: 'alpha' },
          thinkingLevel: 'medium'
        }

        yield* saveDefinition({ definition, override: false })
        const [stored] = yield* readDefinitions
        const sql = yield* SqlClient.SqlClient
        const [row] = yield* sql<{
          readonly definition: string
        }>`SELECT definition FROM definitions`

        assert.deepStrictEqual(stored?.definition, definition)
        assert.deepStrictEqual(JSON.parse(row?.definition ?? '{}').selection, {
          backend: 'other-adapter',
          model: 'alpha'
        })
      })
    )
  )
})
