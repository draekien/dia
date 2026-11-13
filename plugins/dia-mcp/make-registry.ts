import { Effect, Schema, Stream, SubscriptionRef } from 'effect'
import {
  McpServerNameTaken,
  type McpServerRegistry,
  PluginSource,
  type RegisteredServer,
  UserSource
} from './registry'
import { McpServer, type McpServers } from './servers'

const sameServer = Schema.toEquivalence(McpServer)

type Entries = ReadonlyMap<string, RegisteredServer>

/**
 * The registry `mcp` provides, and `replaceUser`, which only `mcp` holds. `replaceUser(servers,
 * persist)` replaces every server the user added with `servers`: it fails with
 * {@link McpServerNameTaken} when a plugin holds a name in `servers`, otherwise it runs `persist`
 * and changes the registry only after `persist` succeeds.
 */
export interface Registry {
  readonly registry: McpServerRegistry
  readonly replaceUser: (
    servers: McpServers,
    persist: Effect.Effect<void>
  ) => Effect.Effect<void, McpServerNameTaken>
}

const byName = (left: RegisteredServer, right: RegisteredServer): number =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0

const sortedList = (entries: Entries): ReadonlyArray<RegisteredServer> =>
  [...entries.values()].sort(byName)

const withUser = (entries: Entries, servers: McpServers): Entries => {
  const next = new Map([...entries].filter(([, entry]) => entry.source._tag !== 'User'))
  const user = UserSource.make({})
  for (const [name, server] of Object.entries(servers)) {
    next.set(name, { name, server, source: user })
  }
  return next
}

/**
 * Makes a registry that holds the user's servers `initial` and no plugin's server. Call it once, in
 * `mcp`'s host setup, with the servers the user saved and `writeUsers`, which persists the whole
 * user list for `importServers`.
 */
export const makeRegistry = (
  initial: McpServers,
  writeUsers: (servers: McpServers) => Effect.Effect<void>
): Effect.Effect<Registry> =>
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(withUser(new Map(), initial))

    const add = (name: string, server: McpServer, plugin: string) =>
      SubscriptionRef.modifyEffect(ref, (entries) => {
        const held = entries.get(name)
        if (held !== undefined) {
          return Effect.fail(new McpServerNameTaken({ name, holder: held.source }))
        }
        const entry: RegisteredServer = { name, server, source: PluginSource.make({ plugin }) }
        return Effect.succeed([entry, new Map(entries).set(name, entry)] as const)
      })

    const remove = (entry: RegisteredServer) =>
      SubscriptionRef.update(ref, (entries) => {
        if (entries.get(entry.name) !== entry) return entries
        const next = new Map(entries)
        next.delete(entry.name)
        return next
      }).pipe(
        Effect.tap(() =>
          Effect.logInfo('MCP server removed', { name: entry.name, source: entry.source })
        )
      )

    const register: McpServerRegistry['register'] = (name, server, plugin) =>
      Effect.acquireRelease(add(name, server, plugin), remove).pipe(
        Effect.tap(() => Effect.logInfo('MCP server registered', { name, plugin })),
        Effect.tapError((error) =>
          Effect.logWarning('MCP server registration refused', {
            name,
            plugin,
            holder: error.holder
          })
        ),
        Effect.asVoid
      )

    const importServers: McpServerRegistry['importServers'] = (servers) =>
      SubscriptionRef.modifyEffect(ref, (entries) =>
        Effect.gen(function* () {
          const next = new Map(entries)
          const user = UserSource.make({})
          const names: Array<string> = []
          let added = 0
          for (const { name, server } of servers) {
            let candidate = name
            for (let n = 2; ; n++) {
              const held = next.get(candidate)
              if (held === undefined) {
                next.set(candidate, { name: candidate, server, source: user })
                added++
                break
              }
              if (sameServer(held.server, server)) break
              candidate = `${name}-${n}`
            }
            names.push(candidate)
          }
          if (added === 0) return [names, entries] as const
          const users = Object.fromEntries(
            [...next.values()]
              .filter((entry) => entry.source._tag === 'User')
              .map((entry) => [entry.name, entry.server])
          )
          yield* writeUsers(users)
          return [names, next] as const
        })
      ).pipe(
        Effect.tap((names) =>
          Effect.logInfo('MCP servers imported', {
            requested: servers.length,
            names: names.length
          })
        )
      )

    const replaceUser: Registry['replaceUser'] = (servers, persist) =>
      SubscriptionRef.modifyEffect(ref, (entries) =>
        Effect.gen(function* () {
          for (const name of Object.keys(servers)) {
            const held = entries.get(name)
            if (held !== undefined && held.source._tag === 'Plugin') {
              return yield* new McpServerNameTaken({ name, holder: held.source })
            }
          }
          yield* persist
          return [undefined, withUser(entries, servers)] as const
        })
      ).pipe(
        Effect.tap(() =>
          Effect.logInfo('User MCP servers saved', { count: Object.keys(servers).length })
        ),
        Effect.tapError((error) =>
          Effect.logWarning('User MCP servers refused', { name: error.name, holder: error.holder })
        )
      )

    return {
      registry: {
        register,
        importServers,
        list: Effect.map(SubscriptionRef.get(ref), sortedList),
        changes: SubscriptionRef.changes(ref).pipe(Stream.map(sortedList))
      },
      replaceUser
    }
  })
