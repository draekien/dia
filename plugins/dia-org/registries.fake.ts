import { makeRegistry as makeDefinitionRegistry } from '@dia-plugin/dia-agent-definitions/make-registry'
import type { AgentDefinitionRegistry } from '@dia-plugin/dia-agent-definitions/registry'
import { agentDefinitionMigrations } from '@dia-plugin/dia-agent-definitions/store'
import { makeRegistry as makeMcpRegistry } from '@dia-plugin/dia-mcp/make-registry'
import type { McpServers } from '@dia-plugin/dia-mcp/servers'
import { makeRegistry as makeSkillRegistry } from '@dia-plugin/dia-skills/make-registry'
import type { Skill, SkillSourceRegistry } from '@dia-plugin/dia-skills/registry'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { Effect, Option, type Scope, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { BUILT_IN_DEFINITIONS } from './built-in-job-titles'
import type { Org } from './service'

/**
 * Opens an agent definition registry over the database `filename` (a new in-memory one by
 * default) for the calling scope, with `org`'s {@link BUILT_IN_DEFINITIONS} contributed under the
 * plugin name `org`.
 */
export const builtInDefinitionRegistry = (
  filename = ':memory:'
): Effect.Effect<AgentDefinitionRegistry, never, Scope.Scope> =>
  Effect.gen(function* () {
    const sql = yield* openDatabase(filename, agentDefinitionMigrations).pipe(Effect.orDie)
    const registry = yield* makeDefinitionRegistry.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(NodeCrypto.layer)
    )
    for (const definition of BUILT_IN_DEFINITIONS) {
      yield* registry.register(definition, 'org').pipe(Effect.orDie)
    }
    return registry
  })

/**
 * Makes `org` hold a {@link builtInDefinitionRegistry} until the calling scope closes, as `org`'s
 * host does once `agent-definitions` is provided, and returns the registry.
 */
export const holdBuiltInDefinitions = (org: Pick<Org, 'holdDefinitions'>, filename?: string) =>
  Effect.gen(function* () {
    const registry = yield* builtInDefinitionRegistry(filename)
    yield* org.holdDefinitions(registry)
    return registry
  })

/** An `mcp` registry whose user servers start as `servers` and are not persisted. */
export const mcpRegistry = (servers: McpServers = {}) => makeMcpRegistry(servers, () => Effect.void)

/**
 * A skills registry with one source, `id`, listing `skills` in every directory and loaded from
 * plugin directory `pluginPath` when given. The source stays registered until the calling scope
 * closes.
 */
export const skillRegistry = (
  id: string,
  skills: ReadonlyArray<Skill>,
  pluginPath: Option.Option<string> = Option.none()
): Effect.Effect<SkillSourceRegistry, never, Scope.Scope> =>
  Effect.gen(function* () {
    const registry = yield* makeSkillRegistry
    yield* registry
      .register({ id, pluginPath, skills: () => Stream.make(skills) })
      .pipe(Effect.orDie)
    return registry
  })
