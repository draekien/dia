import { PermissionRules, ServiceKey, ThinkingLevel, Uuid } from '@dia/plugin'
import { Effect, Predicate, Schema, type Scope, Stream, Struct } from 'effect'

/** Identifies an agent definition; a UUID. A contributed definition keeps the same id on every install. */
export const AgentDefinitionId = Uuid.pipe(Schema.brand('AgentDefinitionId'))
/** The decoded type of {@link AgentDefinitionId}. */
export type AgentDefinitionId = typeof AgentDefinitionId.Type

/** Trimmed, 1-40 characters; unique across listed definitions ignoring ASCII case. */
export const AgentDefinitionName = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(40)),
  Schema.brand('AgentDefinitionName')
)
/** The decoded type of {@link AgentDefinitionName}. */
export type AgentDefinitionName = typeof AgentDefinitionName.Type

/**
 * The setup a session runs with. `skills` are names as `Options.skills` takes them; empty means
 * every skill. `mcpServers` are names in the `mcp` registry. `model` null means the first model
 * the backend lists.
 */
export const AgentDefinition = Schema.Struct({
  id: AgentDefinitionId,
  name: AgentDefinitionName,
  jobDescription: Schema.String,
  skills: Schema.Array(Schema.String),
  permissions: PermissionRules,
  mcpServers: Schema.Array(Schema.String),
  bypassOptIn: Schema.Boolean,
  model: Schema.NullOr(Schema.NonEmptyString),
  thinkingLevel: ThinkingLevel
})
/** The decoded type of {@link AgentDefinition}. */
export type AgentDefinition = typeof AgentDefinition.Type

/** A change to a definition's fields other than `id`; an absent field is left as it is. */
export const AgentDefinitionEdit = AgentDefinition.mapFields((fields) =>
  Struct.map(Struct.omit(fields, ['id']), Schema.optionalKey)
)
/** The decoded type of {@link AgentDefinitionEdit}. */
export type AgentDefinitionEdit = typeof AgentDefinitionEdit.Type

/** The user added the definition. Build one with `UserSource.make({})`. */
export const UserSource = Schema.TaggedStruct('User', {})
/** The plugin named `plugin` contributes the definition. Build one with `PluginSource.make({ plugin })`. */
export const PluginSource = Schema.TaggedStruct('Plugin', { plugin: Schema.NonEmptyString })
/** Who added a definition. */
export const DefinitionSource = Schema.Union([UserSource, PluginSource])
/** The decoded type of {@link DefinitionSource}. */
export type DefinitionSource = typeof DefinitionSource.Type

/** A listed definition. `edited` is true when the user's override replaces a contributed one's fields. */
export const RegisteredDefinition = Schema.Struct({
  definition: AgentDefinition,
  source: DefinitionSource,
  edited: Schema.Boolean
})
/** The decoded type of {@link RegisteredDefinition}. */
export type RegisteredDefinition = typeof RegisteredDefinition.Type

/** `register` refused `id`: another source holds it. */
export class AgentDefinitionIdTaken extends Schema.TaggedError<AgentDefinitionIdTaken>()(
  'AgentDefinitionIdTaken',
  { id: AgentDefinitionId }
) {}

/** Another listed definition has `name`, ignoring ASCII case. */
export class AgentDefinitionNameTaken extends Schema.TaggedError<AgentDefinitionNameTaken>()(
  'AgentDefinitionNameTaken',
  { name: AgentDefinitionName }
) {}

/** No listed definition has `id`. */
export class AgentDefinitionNotFound extends Schema.TaggedError<AgentDefinitionNotFound>()(
  'AgentDefinitionNotFound',
  { id: AgentDefinitionId }
) {}

/** `edit` changed the name of contributed definition `id`. */
export class ContributedDefinitionRenamed extends Schema.TaggedError<ContributedDefinitionRenamed>()(
  'ContributedDefinitionRenamed',
  { id: AgentDefinitionId }
) {}

/** `delete` targeted contributed definition `id`. */
export class ContributedDefinitionDeleted extends Schema.TaggedError<ContributedDefinitionDeleted>()(
  'ContributedDefinitionDeleted',
  { id: AgentDefinitionId }
) {}

/** Every agent definition dia knows. Read it with `ctx.whenProvided([AgentDefinitionRegistryKey], …)`. */
export interface AgentDefinitionRegistry {
  /** Lists `definition` for plugin `plugin` (pass `ctx.name`) until the calling scope closes. Call inside `whenProvided`. */
  readonly register: (
    definition: AgentDefinition,
    plugin: string
  ) => Effect.Effect<void, AgentDefinitionIdTaken | AgentDefinitionNameTaken, Scope.Scope>
  /** Every listed definition: contributed ones first, then by name. */
  readonly list: Effect.Effect<ReadonlyArray<RegisteredDefinition>>
  /** `list` now, then again after each change. */
  readonly changes: Stream.Stream<ReadonlyArray<RegisteredDefinition>>
  /** Stores a new user definition with a fresh id and returns it. */
  readonly create: (
    fields: Omit<AgentDefinition, 'id'>
  ) => Effect.Effect<AgentDefinition, AgentDefinitionNameTaken>
  /** Applies `edit` to the stored user definition, or to the override of a contributed one. */
  readonly edit: (
    id: AgentDefinitionId,
    edit: AgentDefinitionEdit
  ) => Effect.Effect<
    AgentDefinition,
    AgentDefinitionNotFound | AgentDefinitionNameTaken | ContributedDefinitionRenamed
  >
  /** Deletes a user definition. */
  readonly delete: (
    id: AgentDefinitionId
  ) => Effect.Effect<void, AgentDefinitionNotFound | ContributedDefinitionDeleted>
  /** Stores `definitions` as user definitions with their ids; an id already stored is skipped. Only for a one-time move from another store. */
  readonly importDefinitions: (definitions: ReadonlyArray<AgentDefinition>) => Effect.Effect<void>
  /** Stores `overrides` as edits to the contributed definitions with the same ids; an id already stored is skipped. Only for a one-time move from another store. */
  readonly importOverrides: (overrides: ReadonlyArray<AgentDefinition>) => Effect.Effect<void>
}

const MEMBERS: Record<keyof AgentDefinitionRegistry, (member: unknown) => boolean> = {
  register: Predicate.isFunction,
  list: Effect.isEffect,
  changes: Stream.isStream,
  create: Predicate.isFunction,
  edit: Predicate.isFunction,
  delete: Predicate.isFunction,
  importDefinitions: Predicate.isFunction,
  importOverrides: Predicate.isFunction
}

/** Whether `value` has every {@link AgentDefinitionRegistry} member. */
export const isAgentDefinitionRegistry = (value: unknown): value is AgentDefinitionRegistry =>
  Object.entries(MEMBERS).every(
    ([member, check]) => Predicate.hasProperty(value, member) && check(value[member])
  )

/** The key `agent-definitions` provides its {@link AgentDefinitionRegistry} under. */
export const AgentDefinitionRegistryKey = ServiceKey.make(
  'agentDefinitionRegistry',
  isAgentDefinitionRegistry
)
