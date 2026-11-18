import type { SlashCommandInfo } from '@shared/domain/slash-command'
import { useQuery } from '@tanstack/react-query'
import { Duration, Effect } from 'effect'

/** How long a non-empty slash-command answer for a directory is reused before it is read again. */
export const SLASH_COMMANDS_STALE = Duration.minutes(5)

/**
 * The slash commands an agent of adapter `adapter` (an adapter id) started in `cwd` offers, read
 * through `window.dia.adapter.getSlashCommands` and cached per `adapter` and `cwd` for {@link SLASH_COMMANDS_STALE}.
 * Pass `null` to read nothing: `commands` is empty and `loading` false. `loading` is true from
 * the first mount for `cwd` until its first read ends. A rejected read gives an empty list. An
 * empty answer is not kept fresh: the next mount reads again. A window focus never reads.
 */
export function useSlashCommands(
  adapter: string,
  cwd: string | null
): {
  readonly commands: ReadonlyArray<SlashCommandInfo>
  readonly loading: boolean
} {
  const { data, isPending } = useQuery({
    queryKey: ['slashCommands', adapter, cwd],
    queryFn: () =>
      window.dia.adapter
        .getSlashCommands(adapter, cwd ?? '')
        .catch((error: unknown): ReadonlyArray<SlashCommandInfo> => {
          Effect.runSync(Effect.logWarning('Cannot read slash commands', { adapter, cwd, error }))
          return []
        }),
    enabled: cwd !== null,
    staleTime: (query) =>
      query.state.data?.length === 0 ? 0 : Duration.toMillis(SLASH_COMMANDS_STALE),
    refetchOnWindowFocus: false
  })
  return { commands: data ?? [], loading: cwd !== null && isPending }
}
