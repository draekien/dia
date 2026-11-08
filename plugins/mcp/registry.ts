import { ServiceKey } from '@dia/plugin'
import { Effect, Predicate, Schema, type Scope, Stream } from 'effect'
import { McpServer } from './servers'

/** The user added the server, through Settings. */
export const UserSource = Schema.TaggedStruct('User', {})

/** The plugin named `plugin` added the server. */
export const PluginSource = Schema.TaggedStruct('Plugin', { plugin: Schema.NonEmptyString })

/** Who added a server. Build one with `UserSource.make({})` or `PluginSource.make({ plugin })`. */
export const ServerSource = Schema.Union([UserSource, PluginSource])
/** The decoded type of {@link ServerSource}. */
export type ServerSource = typeof ServerSource.Type

/** One server the registry holds: its name, its configuration and who added it. */
export const RegisteredServer = Schema.Struct({
  name: Schema.String,
  server: McpServer,
  source: ServerSource
})
/** The decoded type of {@link RegisteredServer}. */
export type RegisteredServer = typeof RegisteredServer.Type

/** A registration or a save used `name`, which `holder` already holds. */
export class McpServerNameTaken extends Schema.TaggedError<McpServerNameTaken>()(
  'McpServerNameTaken',
  { name: Schema.String, holder: ServerSource }
) {}

/**
 * Every MCP server dia knows, by name, with who added each one. Read it with
 * `ctx.whenProvided([McpServerRegistryKey], …)`.
 */
export interface McpServerRegistry {
  /**
   * Adds `server` under `name` for the plugin named `plugin` (pass `ctx.name`) until the calling
   * scope closes. Call it inside `whenProvided`, so the server is removed when the caller or `mcp`
   * closes and added again when both are open. Fails with {@link McpServerNameTaken} when any
   * source holds `name`. An uncaught failure fails the whole `whenProvided` setup: its other
   * registrations are removed and the setup does not run again until `mcp` is provided again. To
   * keep the other servers, catch `McpServerNameTaken` for each server with `Effect.catchTag`.
   */
  readonly register: (
    name: string,
    server: McpServer,
    plugin: (typeof PluginSource.Type)['plugin']
  ) => Effect.Effect<void, McpServerNameTaken, Scope.Scope>
  /** The servers held now, ordered by name. */
  readonly list: Effect.Effect<ReadonlyArray<RegisteredServer>>
  /** The servers held now, ordered by name, then the whole list again after each change. */
  readonly changes: Stream.Stream<ReadonlyArray<RegisteredServer>>
}

const MEMBERS: Record<keyof McpServerRegistry, (member: unknown) => boolean> = {
  register: Predicate.isFunction,
  list: Effect.isEffect,
  changes: Stream.isStream
}

/** Whether `value` has every {@link McpServerRegistry} member. */
export const isMcpServerRegistry = (value: unknown): value is McpServerRegistry =>
  Object.entries(MEMBERS).every(
    ([member, check]) => Predicate.hasProperty(value, member) && check(value[member])
  )

/** The key the `mcp` plugin provides its {@link McpServerRegistry} under. */
export const McpServerRegistryKey = ServiceKey.make('mcpServerRegistry', isMcpServerRegistry)
