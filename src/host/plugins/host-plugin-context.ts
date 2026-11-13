import type { HostPluginContext as SharedHostPluginContext } from '@shared/plugin/api'
import type { Effect } from 'effect'
import type { DiaTool } from '../session/dia-tools'

/**
 * The context a plugin's `host` entry receives: the shared context (see `@shared/plugin/api`)
 * plus `pluginTools`, which returns the three `plugin_*` tools (`plugin_override`,
 * `plugin_reload`, `plugin_clear_override`) for one agent session. Pass them to the session as
 * dia tools. Each tool runs its plugin operation in a kernel fiber the session's end does not
 * interrupt. An operation on the calling plugin itself waits for `turnEnded`, the end of the
 * session's current turn, and its tool returns at once saying so; any other operation's tool
 * returns its result.
 */
export interface HostPluginContext extends SharedHostPluginContext {
  readonly pluginTools: (turnEnded: Effect.Effect<void>) => ReadonlyArray<DiaTool>
}
