import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  cn,
  Skeleton
} from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import { Cause, Option } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import { CheckIcon } from 'lucide-react'
import type { McpServerPickerProps } from './picker'
import type { RegisteredServer } from './registry'
import type { ServersAtom } from './settings-page'

const headingOf = (server: RegisteredServer): string =>
  server.source._tag === 'User' ? 'Your servers' : `Plugin › ${server.source.plugin}`

const groupsOf = (
  servers: ReadonlyArray<RegisteredServer>
): ReadonlyArray<[string, ReadonlyArray<RegisteredServer>]> => {
  const groups = new Map<string, Array<RegisteredServer>>()
  for (const server of servers) {
    const heading = headingOf(server)
    const group = groups.get(heading)
    if (group === undefined) groups.set(heading, [server])
    else group.push(server)
  }
  return [...groups]
}

function ServerList({
  label,
  value,
  onChange,
  servers
}: McpServerPickerProps & { readonly servers: ReadonlyArray<RegisteredServer> }) {
  const chosen = new Set(value)
  const known = new Set(servers.map((server) => server.name))
  const missing = value.filter((name) => !known.has(name))
  const toggle = (name: string) =>
    onChange(chosen.has(name) ? value.filter((each) => each !== name) : [...value, name])
  const check = (name: string) => (
    <>
      <CheckIcon className={cn(!chosen.has(name) && 'invisible')} />
      <span className="sr-only">{chosen.has(name) ? 'Selected,' : 'Not selected,'}</span>
    </>
  )

  return (
    <div className="flex flex-col gap-1.5">
      <Command label={label} className="border">
        <CommandInput placeholder="Search servers" />
        <CommandList className="max-h-64">
          <CommandEmpty>No server matches.</CommandEmpty>
          {missing.length === 0 ? null : (
            <CommandGroup heading="Missing">
              {missing.map((name) => (
                <CommandItem
                  key={`missing/${name}`}
                  value={`missing/${name}`}
                  keywords={[name]}
                  onSelect={() => toggle(name)}
                >
                  {check(name)}
                  <span className="truncate font-mono text-xs">{name}</span>
                  <span className="text-xs text-ink-muted">(missing)</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {groupsOf(servers).map(([heading, members]) => (
            <CommandGroup key={heading} heading={heading}>
              {members.map((server) => (
                <CommandItem
                  key={`${heading}/${server.name}`}
                  value={`${heading}/${server.name}`}
                  keywords={[server.name]}
                  onSelect={() => toggle(server.name)}
                >
                  {check(server.name)}
                  <span className="truncate font-mono text-xs">{server.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
      <p className="text-xs text-ink-muted">
        {value.length === 0 ? 'None selected.' : `${value.length} selected`}
      </p>
    </div>
  )
}

/**
 * The MCP server picker: every registered server under "Your servers" or "Plugin › <name>", with a
 * search box, and the chosen names checked. Chosen names no server has are listed first as
 * `(missing)`. It follows `serversAtom` while shown.
 */
export function McpServerPicker({
  serversAtom,
  ...props
}: McpServerPickerProps & { readonly serversAtom: ServersAtom }) {
  const result = useAtomValue(serversAtom)
  return AsyncResult.match(result, {
    onInitial: () => <Skeleton className="h-40 w-full" aria-busy="true" />,
    onFailure: ({ cause }) => (
      <p className="text-xs text-error">
        {Cause.prettyErrors(cause)[0]?.message ?? 'Could not list the MCP servers.'}
      </p>
    ),
    onSuccess: ({ value }) =>
      Option.match(value, {
        onNone: () => (
          <p className="text-xs text-ink-muted">The mcp plugin's host entry is not loaded.</p>
        ),
        onSome: (servers) => <ServerList {...props} servers={servers} />
      })
  })
}
