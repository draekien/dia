// @effect-diagnostics asyncFunction:off -- React callbacks await callHost's Promise; components hold no Effect runtime.
import type { PluginServices } from '@dia/plugin'
import {
  Button,
  callHost,
  followHost,
  Label,
  List,
  ListRow,
  ListRowFact,
  ListRowLink,
  ListRowName,
  ListRowSubject,
  type PluginCallInvalid,
  type PluginNotServing,
  SettingsSectionHeading,
  Skeleton
} from '@dia/renderer-plugin'
import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import { Cause, Effect, Option, Result } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { Loader2Icon } from 'lucide-react'
import { useId, useState } from 'react'
import { SaveUserServers, WatchServers } from './calls'
import type { McpServerNameTaken, RegisteredServer } from './registry'
import { type McpServers, mcpServersDraft, readMcpServersDraft } from './servers'
import { McpServersEditor } from './servers-editor'

/** Makes the atom that follows the registry's server list for the `mcp` renderer entry `ctx`. */
export const makeServersAtom = (ctx: Pick<PluginServices, 'name'>) =>
  Atom.make(followHost(ctx, WatchServers, {}))

/** The atom {@link makeServersAtom} makes; {@link McpServersSettings} reads it. */
export type ServersAtom = ReturnType<typeof makeServersAtom>

type SaveFailure = McpServerNameTaken | PluginNotServing | PluginCallInvalid

const userServersOf = (servers: ReadonlyArray<RegisteredServer>): McpServers =>
  Object.fromEntries(
    servers
      .filter((entry) => entry.source._tag === 'User')
      .map((entry) => [entry.name, entry.server])
  )

const sortedByName = (servers: McpServers): McpServers =>
  Object.fromEntries(
    Object.entries(servers).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  )

const failureText = (failure: SaveFailure): string => {
  switch (failure._tag) {
    case 'McpServerNameTaken':
      return failure.holder._tag === 'Plugin'
        ? `${failure.name} is provided by the ${failure.holder.plugin} plugin. Rename your server.`
        : `${failure.name} is already one of your servers.`
    case 'PluginNotServing':
    case 'PluginCallInvalid':
      return failure.message
  }
}

const saveServers = (ctx: Pick<PluginServices, 'name'>, servers: McpServers) =>
  Effect.gen(function* () {
    yield* Effect.logInfo('Saving user MCP servers', { count: Object.keys(servers).length })
    const result = yield* Effect.result(callHost(ctx, SaveUserServers, { servers }))
    if (Result.isFailure(result)) {
      yield* Effect.logWarning('Saving user MCP servers failed', { reason: result.failure._tag })
    }
    return result
  })

function UserServers({
  ctx,
  servers
}: {
  readonly ctx: Pick<PluginServices, 'name'>
  readonly servers: ReadonlyArray<RegisteredServer>
}) {
  const editorId = useId()
  const baseline = mcpServersDraft(userServersOf(servers))
  const [shownBaseline, setShownBaseline] = useState(baseline)
  const [draft, setDraft] = useState(baseline)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  if (shownBaseline !== baseline) {
    setShownBaseline(baseline)
    if (draft === shownBaseline) setDraft(baseline)
  }

  const save = async () => {
    const parsed = readMcpServersDraft(draft)
    if (Result.isFailure(parsed)) return setError(parsed.failure)
    setSaving(true)
    const result = await Effect.runPromise(saveServers(ctx, parsed.success))
      .catch(() => undefined)
      .finally(() => setSaving(false))
    if (result === undefined) return setError('Could not save the servers.')
    if (Result.isFailure(result)) return setError(failureText(result.failure))
    setError(undefined)
    setDraft(mcpServersDraft(sortedByName(parsed.success)))
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby={`${editorId}-heading`}>
      <SettingsSectionHeading id={`${editorId}-heading`}>Your servers</SettingsSectionHeading>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={editorId} className="sr-only">
          Your MCP servers as JSON
        </Label>
        <McpServersEditor
          id={editorId}
          draft={draft}
          onChange={(next) => {
            setDraft(next)
            setError(undefined)
          }}
          error={error}
        />
      </div>
      <div>
        <Button size="sm" disabled={saving || draft === baseline} onClick={() => void save()}>
          {saving ? <Loader2Icon className="motion-safe:animate-spin" /> : null}
          Save
        </Button>
      </div>
    </section>
  )
}

function PluginServers({ servers }: { readonly servers: ReadonlyArray<RegisteredServer> }) {
  const fromPlugins = servers.flatMap((entry) =>
    entry.source._tag === 'Plugin' ? [{ ...entry, plugin: entry.source.plugin }] : []
  )
  return (
    <section className="flex flex-col gap-3 border-t pt-6" aria-labelledby="mcp-plugin-servers">
      <SettingsSectionHeading id="mcp-plugin-servers">From plugins</SettingsSectionHeading>
      {fromPlugins.length === 0 ? (
        <p className="text-sm text-ink-muted">No plugin adds an MCP server.</p>
      ) : (
        <List aria-labelledby="mcp-plugin-servers">
          {fromPlugins.map((entry) => (
            <ListRow key={entry.name} value={entry.name}>
              <ListRowLink render={<div />} title={entry.name}>
                <ListRowSubject>
                  <ListRowName className="font-mono text-xs">{entry.name}</ListRowName>
                </ListRowSubject>
                <ListRowFact className="text-xs text-ink-muted">{entry.server.type}</ListRowFact>
                <ListRowFact className="text-xs text-ink-muted">{entry.plugin}</ListRowFact>
              </ListRowLink>
            </ListRow>
          ))}
        </List>
      )}
      <p className="text-xs text-ink-muted">
        A plugin's servers are listed while the plugin is loaded, and you cannot edit them here.
      </p>
    </section>
  )
}

/**
 * The MCP servers page of the Settings dialog: the user's servers in the MCP servers editor with
 * Save, and the servers plugins add, read-only. It follows `serversAtom` while shown; `ctx` is the
 * `mcp` renderer entry the save call goes through.
 */
export function McpServersSettings({
  ctx,
  serversAtom
}: {
  readonly ctx: Pick<PluginServices, 'name'>
  readonly serversAtom: ServersAtom
}) {
  const result = useAtomValue(serversAtom)
  const retry = useAtomRefresh(serversAtom)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-6">
      {AsyncResult.match(result, {
        onInitial: () => <Skeleton className="h-24 w-full" aria-busy="true" />,
        onFailure: ({ cause }) => (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-error">{Cause.prettyErrors(cause)[0]?.message}</p>
            <Button size="sm" variant="outline" onClick={retry}>
              Try again
            </Button>
          </div>
        ),
        onSuccess: ({ value }) =>
          Option.match(value, {
            onNone: () => (
              <p className="text-sm text-ink-muted">The mcp plugin's host entry is not loaded.</p>
            ),
            onSome: (servers) => (
              <>
                <UserServers ctx={ctx} servers={servers} />
                <PluginServers servers={servers} />
              </>
            )
          })
      })}
    </div>
  )
}
