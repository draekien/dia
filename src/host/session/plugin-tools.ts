import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool
} from '@anthropic-ai/claude-agent-sdk'
import type { PluginInfo, PluginOverrideResult } from '@shared/plugin/manifest'
import { Effect } from 'effect'
import { z } from 'zod'

/** Key under which the plugin tools' MCP server is passed in `mcpServers`; it is the server segment of every tool name. */
export const PLUGIN_TOOL_SERVER_KEY = 'dia'

const PLUGIN_TOOL_NAMES = ['plugin_override', 'plugin_reload', 'plugin_clear_override'] as const

const qualified = (name: string): string => `mcp__${PLUGIN_TOOL_SERVER_KEY}__${name}`

/**
 * Whether `toolName` is one of the plugin tools, as the SDK reports it to `canUseTool`
 * (`mcp__dia__plugin_reload`). The tools ask the user for approval themselves, so a caller
 * that also gates tools with `canUseTool` must let these through to avoid asking twice.
 */
export const isPluginToolName = (toolName: string): boolean =>
  PLUGIN_TOOL_NAMES.some((name) => toolName === qualified(name))

/**
 * What the plugin tools can do to the Host's plugins. `reload` loads or reloads a plugin and
 * returns its resulting state; `setOverride` points a plugin at a source folder without loading
 * it; `clearOverride` returns it to the bundled copy without loading it.
 */
export interface PluginToolHost {
  readonly reload: (name: string) => Effect.Effect<PluginInfo>
  readonly setOverride: (name: string, directory: string) => Effect.Effect<PluginOverrideResult>
  readonly clearOverride: (name: string) => Effect.Effect<void>
}

/** Collaborators of {@link makePluginTools}. */
export interface PluginToolOptions {
  readonly host: PluginToolHost
  /** Asks the user to approve a call and resolves whether they did. Called once per tool call, whatever the permission mode. */
  readonly approve: (toolName: string, input: Record<string, string>) => Effect.Effect<boolean>
  /** Runs an effect to completion; the SDK calls tool handlers with a Promise. */
  readonly run: <A>(effect: Effect.Effect<A>) => Promise<A>
}

interface ToolResult {
  readonly [key: string]: unknown
  readonly content: Array<{ readonly type: 'text'; readonly text: string }>
  readonly isError?: boolean
}

const text = (value: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: value }],
  ...(isError ? { isError: true } : {})
})

const report = (info: PluginInfo): ToolResult => {
  const { status } = info
  switch (status._tag) {
    case 'Loaded':
      return status.reloadError === undefined
        ? text(`Plugin "${info.name}" is loaded.`)
        : text(
            `Plugin "${info.name}" kept running its previous version; the reload failed: ${status.reloadError}`,
            true
          )
    case 'Failed':
      return text(`Plugin "${info.name}" failed to load: ${status.message}`, true)
    case 'RestartRequired':
      return text(`Plugin "${info.name}" cannot reload until dia restarts: ${status.message}`, true)
    case 'Waiting':
      return text(
        `Plugin "${info.name}" is waiting for ${status.missing.join(', ')} to be provided.`,
        true
      )
    case 'Unloaded':
      return text(`Plugin "${info.name}" is not loaded.`)
  }
}

const pluginName = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .describe('Name of the plugin: lowercase letters, digits and hyphens.')

/**
 * The three tools an agent uses to change which source a plugin loads from and to reload it:
 * `plugin_override` (set a source folder, then reload), `plugin_reload` and
 * `plugin_clear_override` (return to the bundled copy, then reload). Every call first asks the
 * user through `approve` and does nothing when they decline, so approval does not depend on the
 * pane's permission mode. A result with `isError` set tells the agent the plugin did not end up
 * loaded cleanly.
 */
export const makePluginTools = (options: PluginToolOptions) => {
  const guarded = (
    name: (typeof PLUGIN_TOOL_NAMES)[number],
    input: Record<string, string>,
    act: Effect.Effect<ToolResult>
  ): Promise<ToolResult> =>
    options.run(
      Effect.gen(function* () {
        const approved = yield* options.approve(qualified(name), input)
        if (!approved) {
          yield* Effect.logInfo('Plugin tool call declined', { tool: name, input })
          return text('The user did not approve this plugin change.', true)
        }
        yield* Effect.logInfo('Plugin tool call approved', { tool: name, input })
        return yield* act
      })
    )

  return [
    tool(
      'plugin_override',
      "Point a dia plugin at a source folder on disk and reload it, so the plugin runs that folder's code. The folder must hold a plugin.json and resolve to a package with type module. Asks the user to approve.",
      {
        name: pluginName,
        directory: z
          .string()
          .min(1)
          .describe('Absolute path of the folder holding the plugin source.')
      },
      (args) =>
        guarded(
          'plugin_override',
          args,
          Effect.gen(function* () {
            const result = yield* options.host.setOverride(args.name, args.directory)
            if (result._tag === 'Rejected') return text(`Override refused: ${result.message}`, true)
            return report(yield* options.host.reload(args.name))
          })
        )
    ),
    tool(
      'plugin_reload',
      'Reload a dia plugin so it runs its current source. If the new version fails, the previous one keeps running and the failure is reported. Asks the user to approve.',
      { name: pluginName },
      (args) =>
        guarded('plugin_reload', args, options.host.reload(args.name).pipe(Effect.map(report)))
    ),
    tool(
      'plugin_clear_override',
      'Return a dia plugin to the copy that ships with dia and reload it. Asks the user to approve.',
      { name: pluginName },
      (args) =>
        guarded(
          'plugin_clear_override',
          args,
          Effect.gen(function* () {
            yield* options.host.clearOverride(args.name)
            return report(yield* options.host.reload(args.name))
          })
        )
    )
  ]
}

/**
 * An in-process MCP server carrying the {@link makePluginTools}. Create one for each `query()`:
 * the SDK connects a server instance to a single query. Pass it as
 * `mcpServers: { [PLUGIN_TOOL_SERVER_KEY]: server }`.
 */
export const makePluginToolServer = (options: PluginToolOptions): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({ name: PLUGIN_TOOL_SERVER_KEY, tools: [...makePluginTools(options)] })
