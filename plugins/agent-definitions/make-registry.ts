import { Crypto, Effect, Stream, SubscriptionRef } from 'effect'
import { SqlClient } from 'effect/sql'
import {
  type AgentDefinition,
  AgentDefinitionId,
  AgentDefinitionIdTaken,
  AgentDefinitionNameTaken,
  AgentDefinitionNotFound,
  type AgentDefinitionRegistry,
  ContributedDefinitionDeleted,
  ContributedDefinitionRenamed,
  PluginSource,
  type RegisteredDefinition,
  UserSource
} from './registry'
import { deleteDefinition, readDefinitions, type StoredDefinition, saveDefinition } from './store'

interface Contribution {
  readonly definition: AgentDefinition
  readonly plugin: string
}

interface State {
  readonly stored: ReadonlyMap<string, StoredDefinition>
  readonly contributions: ReadonlyArray<Contribution>
}

const asciiLower = (name: string): string => name.replace(/[A-Z]/g, (c) => c.toLowerCase())

const byName = (left: AgentDefinition, right: AgentDefinition): number =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0

const listed = (state: State): ReadonlyArray<RegisteredDefinition> => {
  const contributed = state.contributions.map(({ definition, plugin }): RegisteredDefinition => {
    const override = state.stored.get(definition.id)
    const source = PluginSource.make({ plugin })
    return override?.override === true
      ? {
          definition: { ...override.definition, id: definition.id, name: definition.name },
          source,
          edited: true
        }
      : { definition, source, edited: false }
  })
  const user = [...state.stored.values()]
    .filter((entry) => !entry.override)
    .map(
      (entry): RegisteredDefinition => ({
        definition: entry.definition,
        source: UserSource.make({}),
        edited: false
      })
    )
    .sort((left, right) => byName(left.definition, right.definition))
  return [...contributed, ...user]
}

const nameHeldBy = (state: State, name: string, exceptId: string | null): boolean =>
  listed(state).some(
    ({ definition }) =>
      definition.id !== exceptId && asciiLower(definition.name) === asciiLower(name)
  )

/**
 * Makes the registry `agent-definitions` provides, over the definitions stored in the database the
 * ambient `SqlClient` opens (already migrated with `agentDefinitionMigrations`). Call it once per
 * database, in the plugin's setup. Every change is written to the database before the registry's
 * lists change.
 */
export const makeRegistry: Effect.Effect<
  AgentDefinitionRegistry,
  never,
  SqlClient.SqlClient | Crypto.Crypto
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto
  const initial = yield* readDefinitions
  const ref = yield* SubscriptionRef.make<State>({
    stored: new Map(initial.map((entry) => [entry.definition.id, entry])),
    contributions: []
  })

  const withStored = (state: State, entry: StoredDefinition): State => ({
    ...state,
    stored: new Map(state.stored).set(entry.definition.id, entry)
  })

  const persist = (entry: StoredDefinition) =>
    saveDefinition(entry).pipe(Effect.provideService(SqlClient.SqlClient, sql))
  const unpersist = (id: AgentDefinitionId) =>
    deleteDefinition(id).pipe(Effect.provideService(SqlClient.SqlClient, sql))

  const register: AgentDefinitionRegistry['register'] = (definition, plugin) => {
    const contribution: Contribution = { definition, plugin }
    const add = SubscriptionRef.modifyEffect(
      ref,
      (
        state
      ): Effect.Effect<
        readonly [undefined, State],
        AgentDefinitionIdTaken | AgentDefinitionNameTaken
      > => {
        const entries = listed(state)
        if (entries.some((entry) => entry.definition.id === definition.id)) {
          return Effect.fail(new AgentDefinitionIdTaken({ id: definition.id }))
        }
        if (nameHeldBy(state, definition.name, null)) {
          return Effect.fail(new AgentDefinitionNameTaken({ name: definition.name }))
        }
        return Effect.succeed([
          undefined,
          { ...state, contributions: [...state.contributions, contribution] }
        ] as const)
      }
    )
    const release = SubscriptionRef.update(ref, (state) => ({
      ...state,
      contributions: state.contributions.filter((held) => held !== contribution)
    })).pipe(
      Effect.tap(() => Effect.logInfo('Agent definition removed', { id: definition.id, plugin }))
    )
    return Effect.acquireRelease(add, () => release).pipe(
      Effect.tap(() =>
        Effect.logInfo('Agent definition registered', { id: definition.id, plugin })
      ),
      Effect.tapError((error) =>
        Effect.logWarning('Agent definition registration refused', {
          id: definition.id,
          plugin,
          reason: error._tag
        })
      )
    )
  }

  const create: AgentDefinitionRegistry['create'] = (fields) =>
    SubscriptionRef.modifyEffect(ref, (state) =>
      Effect.gen(function* () {
        if (nameHeldBy(state, fields.name, null)) {
          return yield* new AgentDefinitionNameTaken({ name: fields.name })
        }
        const id = AgentDefinitionId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie))
        const definition: AgentDefinition = { ...fields, id }
        const entry = { definition, override: false }
        yield* persist(entry)
        return [definition, withStored(state, entry)] as const
      })
    ).pipe(
      Effect.tap((definition) => Effect.logInfo('Agent definition created', { id: definition.id })),
      Effect.tapError((error) =>
        Effect.logWarning('Agent definition create refused', { name: error.name })
      )
    )

  const edit: AgentDefinitionRegistry['edit'] = (id, change) =>
    SubscriptionRef.modifyEffect(ref, (state) =>
      Effect.gen(function* () {
        const current = listed(state).find((entry) => entry.definition.id === id)
        if (current === undefined) return yield* new AgentDefinitionNotFound({ id })
        const contributed = current.source._tag === 'Plugin'
        if (contributed && change.name !== undefined && change.name !== current.definition.name) {
          return yield* new ContributedDefinitionRenamed({ id })
        }
        const definition: AgentDefinition = { ...current.definition, ...change, id }
        if (nameHeldBy(state, definition.name, id)) {
          return yield* new AgentDefinitionNameTaken({ name: definition.name })
        }
        const entry = { definition, override: contributed }
        yield* persist(entry)
        return [definition, withStored(state, entry)] as const
      })
    ).pipe(
      Effect.tap((definition) => Effect.logInfo('Agent definition edited', { id: definition.id })),
      Effect.tapError((error) =>
        Effect.logWarning('Agent definition edit refused', { id, reason: error._tag })
      )
    )

  const forget: AgentDefinitionRegistry['delete'] = (id) =>
    SubscriptionRef.modifyEffect(ref, (state) =>
      Effect.gen(function* () {
        const current = listed(state).find((entry) => entry.definition.id === id)
        if (current === undefined) return yield* new AgentDefinitionNotFound({ id })
        if (current.source._tag === 'Plugin') {
          return yield* new ContributedDefinitionDeleted({ id })
        }
        yield* unpersist(id)
        const stored = new Map(state.stored)
        stored.delete(id)
        return [undefined, { ...state, stored }] as const
      })
    ).pipe(
      Effect.tap(() => Effect.logInfo('Agent definition deleted', { id })),
      Effect.tapError((error) =>
        Effect.logWarning('Agent definition delete refused', { id, reason: error._tag })
      )
    )

  const importAll = (
    definitions: ReadonlyArray<AgentDefinition>,
    override: boolean
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      let imported = 0
      for (const definition of definitions) {
        const added = yield* SubscriptionRef.modifyEffect(ref, (state) =>
          Effect.gen(function* () {
            if (state.stored.has(definition.id)) return [false, state] as const
            if (
              !override &&
              state.contributions.some((held) => held.definition.id === definition.id)
            ) {
              yield* Effect.logWarning('Agent definition import skipped: id contributed', {
                id: definition.id
              })
              return [false, state] as const
            }
            if (!override && nameHeldBy(state, definition.name, null)) {
              yield* Effect.logWarning('Agent definition import skipped: name taken', {
                id: definition.id,
                name: definition.name
              })
              return [false, state] as const
            }
            const entry = { definition, override }
            yield* persist(entry)
            return [true, withStored(state, entry)] as const
          })
        )
        if (added) imported += 1
      }
      yield* Effect.logInfo('Agent definitions imported', {
        override,
        offered: definitions.length,
        imported
      })
    })

  return {
    register,
    list: Effect.map(SubscriptionRef.get(ref), listed),
    changes: SubscriptionRef.changes(ref).pipe(Stream.map(listed)),
    create,
    edit,
    delete: forget,
    importDefinitions: (definitions) => importAll(definitions, false),
    importOverrides: (overrides) => importAll(overrides, true)
  }
})
