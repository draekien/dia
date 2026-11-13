import type { DiaTool, ToolScope } from '@dia/plugin'
import { Effect, Option, PubSub, Ref, type Scope, Stream } from 'effect'
import type { ToolRegistration } from './tools'

interface Registered {
  readonly id: number
  readonly tool: DiaTool
  readonly when: (scope: ToolScope) => boolean
}

/**
 * The registered tools and granted token hashes `dia-tools` serves. `register` and `forScope`
 * behave as `Tools` documents them; `scopeOf` is the scope a token hash was granted, none for an
 * unknown or revoked hash; `changes` emits once after each change to the registered tools.
 */
export interface ToolRegistry {
  readonly register: (
    tool: DiaTool,
    options: ToolRegistration
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly forScope: (scope: ToolScope) => Effect.Effect<ReadonlyArray<DiaTool>>
  readonly grant: (tokenHash: string, scope: ToolScope) => Effect.Effect<void>
  readonly revoke: (tokenHash: string) => Effect.Effect<void>
  readonly scopeOf: (tokenHash: string) => Effect.Effect<Option.Option<ToolScope>>
  readonly changes: Stream.Stream<void>
}

/** Builds an empty {@link ToolRegistry}. */
export const makeToolRegistry = Effect.gen(function* () {
  const tools = yield* Ref.make<ReadonlyArray<Registered>>([])
  const grants = yield* Ref.make<ReadonlyMap<string, ToolScope>>(new Map())
  const nextId = yield* Ref.make(0)
  const changed = yield* PubSub.sliding<void>(1)

  const add = Effect.fnUntraced(function* (tool: DiaTool, options: ToolRegistration) {
    const id = yield* Ref.getAndUpdate(nextId, (n) => n + 1)
    yield* Ref.update(tools, (current) => [...current, { id, tool, when: options.when }])
    yield* Effect.logInfo('Registered a dia tool', { tool: tool.name })
    yield* PubSub.publish(changed, undefined)
    return id
  })

  const remove = Effect.fnUntraced(function* (id: number, name: string) {
    yield* Ref.update(tools, (current) => current.filter((entry) => entry.id !== id))
    yield* Effect.logInfo('Unregistered a dia tool', { tool: name })
    yield* PubSub.publish(changed, undefined)
  })

  const registry: ToolRegistry = {
    register: (tool, options) =>
      Effect.acquireRelease(add(tool, options), (id) => remove(id, tool.name)).pipe(Effect.asVoid),
    forScope: (scope) =>
      Effect.map(Ref.get(tools), (current) => {
        const byName = new Map<string, DiaTool>()
        for (const entry of current) {
          if (!byName.has(entry.tool.name) && entry.when(scope)) {
            byName.set(entry.tool.name, entry.tool)
          }
        }
        return [...byName.values()]
      }),
    grant: (tokenHash, scope) =>
      Ref.update(grants, (current) => new Map(current).set(tokenHash, scope)).pipe(
        Effect.andThen(Effect.logDebug('Granted a dia tools token', { runId: scope.runId }))
      ),
    revoke: (tokenHash) =>
      Ref.update(grants, (current) => {
        const next = new Map(current)
        next.delete(tokenHash)
        return next
      }).pipe(Effect.andThen(Effect.logDebug('Revoked a dia tools token'))),
    scopeOf: (tokenHash) =>
      Effect.map(Ref.get(grants), (current) => Option.fromUndefinedOr(current.get(tokenHash))),
    changes: Stream.fromPubSub(changed)
  }
  return registry
})
