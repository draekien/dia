import { SessionToolOptions } from '@dia/plugin'
import type { AgentDefinition } from '@dia-plugin/agent-definitions/registry'
import type { McpServerRegistry } from '@dia-plugin/mcp/registry'
import type { SkillSourceRegistry } from '@dia-plugin/skills/registry'
import { Effect, Option, PubSub, Schema, type Scope, Stream, SubscriptionRef } from 'effect'
import { MissingReference } from './domain'

/** The definition's names all resolved: the session's tools and the plugin directories it loads. */
export const SessionToolsReady = Schema.TaggedStruct('Ready', {
  tools: SessionToolOptions,
  pluginPaths: Schema.Array(Schema.String)
})

/** Names that resolve to nothing in a registry that is provided and settled. */
export const SessionToolsMissing = Schema.TaggedStruct('Missing', {
  missing: Schema.NonEmptyArray(MissingReference)
})

/** A registry the definition needs is not provided, or not settled yet; try again later. */
export const SessionToolsUnavailable = Schema.TaggedStruct('Unavailable', {})

/** What `SessionTools.forDefinition` found. Build each case with its `.make`. */
export const SessionToolsResult = Schema.Union([
  SessionToolsReady,
  SessionToolsMissing,
  SessionToolsUnavailable
])
export type SessionToolsResult = typeof SessionToolsResult.Type

/** Resolves agent definitions' names for sessions, against the registries `org` currently holds. */
export interface SessionTools {
  /**
   * Resolves `definition`'s names in `cwd`. An MCP server name resolves when the `mcp` registry
   * lists it; a skill name when a skill source lists it. `Unavailable` when the definition names
   * MCP servers and `mcp` is not held, names skills and `resolve` returns none, or a name is
   * missing before `pluginsSettled` has resolved.
   */
  readonly forDefinition: (
    definition: AgentDefinition,
    cwd: string
  ) => Effect.Effect<SessionToolsResult>
  /** Holds `registry` until the calling scope closes. Call inside `whenProvided([McpServerRegistryKey], …)`. */
  readonly holdMcp: (registry: McpServerRegistry) => Effect.Effect<void, never, Scope.Scope>
  /** Holds `registry` until the calling scope closes. Call inside `whenProvided([SkillSourceRegistryKey], …)`. */
  readonly holdSkills: (registry: SkillSourceRegistry) => Effect.Effect<void, never, Scope.Scope>
  /**
   * Subscribes when run; the stream emits after each hold, each release, and once when
   * `pluginsSettled` resolves.
   */
  readonly changes: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
  /**
   * Emits at once, then after each emission of `changes`, each change to the held `mcp`
   * registry's servers, and each change to the held skill sources' skills for `cwd`: whenever
   * `forDefinition(…, cwd)` may resolve differently.
   */
  readonly references: (cwd: string) => Stream.Stream<void>
}

interface Held {
  readonly mcp: Option.Option<McpServerRegistry>
  readonly skills: Option.Option<SkillSourceRegistry>
  readonly settled: boolean
}

const mcpMissingFrom = Effect.fnUntraced(function* (
  names: ReadonlyArray<string>,
  registry: McpServerRegistry
) {
  const listed = new Map((yield* registry.list).map((entry) => [entry.name, entry.server]))
  const servers: Record<string, unknown> = {}
  const missing: Array<MissingReference> = []
  for (const name of names) {
    const server = listed.get(name)
    if (server === undefined) missing.push(MissingReference.make({ kind: 'mcp-server', name }))
    else servers[name] = server
  }
  return { servers, missing }
})

/**
 * Makes the {@link SessionTools} for `org`'s setup scope. `pluginsSettled` is the plugin's
 * `ctx.pluginsSettled`; it is awaited in a fiber of the calling scope.
 */
export const makeSessionTools = (
  pluginsSettled: Effect.Effect<void>
): Effect.Effect<SessionTools, never, Scope.Scope> =>
  Effect.gen(function* () {
    const held = yield* SubscriptionRef.make<Held>({
      mcp: Option.none(),
      skills: Option.none(),
      settled: false
    })
    const changes = yield* PubSub.unbounded<void>()
    const publish = PubSub.publish(changes, undefined)

    const setHeld = (update: (current: Held) => Held) =>
      SubscriptionRef.update(held, update).pipe(Effect.andThen(publish))

    yield* pluginsSettled.pipe(
      Effect.andThen(setHeld((current) => ({ ...current, settled: true }))),
      Effect.andThen(Effect.logDebug('Org session tools: plugins settled')),
      Effect.forkScoped
    )

    const hold = (
      registry: 'mcp' | 'skills',
      fill: (current: Held) => Held,
      empty: Partial<Held>
    ) =>
      Effect.acquireRelease(
        setHeld(fill).pipe(
          Effect.andThen(Effect.logDebug('Org session tools hold a registry', { registry }))
        ),
        () =>
          setHeld((current) => ({ ...current, ...empty })).pipe(
            Effect.andThen(Effect.logDebug('Org session tools released a registry', { registry }))
          )
      ).pipe(Effect.asVoid)

    const forDefinition = Effect.fnUntraced(function* (definition: AgentDefinition, cwd: string) {
      const current = yield* SubscriptionRef.get(held)
      let servers: Record<string, unknown> = {}
      const missing: Array<MissingReference> = []
      let pluginPaths: ReadonlyArray<string> = []
      if (definition.mcpServers.length > 0) {
        if (Option.isNone(current.mcp)) return SessionToolsUnavailable.make({})
        const resolved = yield* mcpMissingFrom(definition.mcpServers, current.mcp.value)
        servers = resolved.servers
        missing.push(...resolved.missing)
      }
      if (definition.skills.length > 0) {
        if (Option.isNone(current.skills)) return SessionToolsUnavailable.make({})
        const resolved = yield* current.skills.value.resolve(definition.skills, {
          cwd: Option.some(cwd)
        })
        if (Option.isNone(resolved)) return SessionToolsUnavailable.make({})
        missing.push(
          ...resolved.value.missing.map((name) => MissingReference.make({ kind: 'skill', name }))
        )
        pluginPaths = resolved.value.pluginPaths
      }
      const [first, ...rest] = missing
      if (first !== undefined) {
        if (!current.settled) {
          yield* Effect.logDebug('Names missing before plugins settled', {
            definitionId: definition.id,
            missing
          })
          return SessionToolsUnavailable.make({})
        }
        return SessionToolsMissing.make({ missing: [first, ...rest] })
      }
      return SessionToolsReady.make({
        tools: {
          permissions: definition.permissions,
          mcpServers: servers,
          skills: definition.skills
        },
        pluginPaths
      })
    })

    const references = (cwd: string) =>
      SubscriptionRef.changes(held).pipe(
        Stream.switchMap((current) =>
          Stream.mergeAll(
            [
              Stream.make(undefined),
              Option.match(current.mcp, {
                onNone: () => Stream.empty,
                onSome: (registry) => Stream.map(registry.changes, () => undefined)
              }),
              Option.match(current.skills, {
                onNone: () => Stream.empty,
                onSome: (registry) =>
                  Stream.map(registry.skills({ cwd: Option.some(cwd) }), () => undefined)
              })
            ],
            { concurrency: 'unbounded' }
          )
        )
      )

    return {
      forDefinition,
      holdMcp: (registry) =>
        hold('mcp', (current) => ({ ...current, mcp: Option.some(registry) }), {
          mcp: Option.none()
        }),
      holdSkills: (registry) =>
        hold('skills', (current) => ({ ...current, skills: Option.some(registry) }), {
          skills: Option.none()
        }),
      changes: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
      references
    } satisfies SessionTools
  })
