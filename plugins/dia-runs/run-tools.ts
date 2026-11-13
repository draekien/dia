import { type DiaTool, isRunScope, type SessionToolOptions, type ToolScope } from '@dia/plugin'
import { DIA_SERVER_NAME, newToken, type Tools } from '@dia-plugin/dia-tools/tools'
import { type Crypto, Effect, Option, Ref, type Scope } from 'effect'

interface Grant {
  readonly hash: string
  readonly scope: ToolScope
}

/**
 * The dia tools tokens of `dia-runs`' live runs. `follow` connects one `Tools` provider until the
 * calling scope closes: it grants every live run's token and registers `pluginTools` for run
 * scopes. `sessionTools` issues run `scope.runId`'s token, grants it while the calling scope (the
 * run's) is open, and returns the session's `tools` option carrying the `dia` HTTP MCP server, or
 * none while no `Tools` provider is loaded.
 */
export interface RunTools {
  readonly follow: (
    tools: Tools,
    pluginTools: ReadonlyArray<DiaTool>
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly sessionTools: (
    scope: ToolScope & { readonly runId: string }
  ) => Effect.Effect<Option.Option<SessionToolOptions>, never, Scope.Scope>
}

/** Builds {@link RunTools}; tokens are generated with the `Crypto` service in context. */
export const makeRunTools = Effect.gen(function* () {
  const crypto = yield* Effect.context<Crypto.Crypto>()
  const grants = yield* Ref.make<ReadonlyMap<string, Grant>>(new Map())
  const provider = yield* Ref.make(Option.none<Tools>())

  const withProvider = (use: (tools: Tools) => Effect.Effect<void>) =>
    Effect.flatMap(Ref.get(provider), Option.match({ onNone: () => Effect.void, onSome: use }))

  const follow = Effect.fnUntraced(function* (tools: Tools, pluginTools: ReadonlyArray<DiaTool>) {
    yield* Effect.acquireRelease(Ref.set(provider, Option.some(tools)), () =>
      Ref.set(provider, Option.none())
    )
    const live = yield* Ref.get(grants)
    yield* Effect.forEach(live.values(), (grant) => tools.grant(grant.hash, grant.scope), {
      discard: true
    })
    yield* Effect.forEach(pluginTools, (tool) => tools.register(tool, { when: isRunScope }), {
      discard: true
    })
    yield* Effect.logInfo('Runs follow the dia tools registry', { liveRuns: live.size })
  })

  const sessionTools = Effect.fnUntraced(function* (scope: ToolScope & { readonly runId: string }) {
    const tools = yield* Ref.get(provider)
    if (Option.isNone(tools)) {
      yield* Effect.logWarning('No dia tools registry; the run gets no dia tools', {
        runId: scope.runId
      })
      return Option.none<SessionToolOptions>()
    }
    const { token, hash } = yield* newToken.pipe(Effect.provide(crypto))
    yield* Effect.acquireRelease(
      Ref.update(grants, (current) => new Map(current).set(scope.runId, { hash, scope })).pipe(
        Effect.andThen(withProvider((current) => current.grant(hash, scope)))
      ),
      () =>
        Ref.update(grants, (current) => {
          const next = new Map(current)
          next.delete(scope.runId)
          return next
        }).pipe(
          Effect.andThen(withProvider((current) => current.revoke(hash))),
          Effect.andThen(Effect.logDebug('Revoked a run dia tools token', { runId: scope.runId }))
        )
    )
    return Option.some<SessionToolOptions>({
      permissions: { allow: [], ask: [], deny: [] },
      mcpServers: {
        [DIA_SERVER_NAME]: {
          type: 'http',
          url: tools.value.url,
          headers: { Authorization: `Bearer ${token}` }
        }
      },
      skills: []
    })
  })

  const runTools: RunTools = { follow, sessionTools }
  return runTools
})
