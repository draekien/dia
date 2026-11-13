import type { PluginInfo, PluginOverrideResult } from '@shared/plugin/manifest'
import { Effect, Fiber, Schema } from 'effect'

/**
 * Who a dia tool call comes from. A run that dia started has `runId` and `project` (the run's
 * source directory); an agent outside dia has neither. `labels` and `context` are what the caller
 * that started the run supplied (empty and undefined for a tab); `context` reaches every tool
 * handler unchanged.
 */
export const ToolScope = Schema.Struct({
  runId: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  labels: Schema.Array(Schema.String),
  context: Schema.Unknown
})
export type ToolScope = typeof ToolScope.Type

/** True for the scope of a run dia started; false for an agent outside dia. */
export const isRunScope = (scope: ToolScope): boolean => scope.runId !== undefined

/** The input schema a {@link DiaTool} may declare: a struct that decodes with no services. */
export type ToolInput = Schema.Top & { readonly DecodingServices: never }

/** What a {@link DiaTool} call returns to the agent. `isError` tells the agent the call did not do what it asked. */
export interface DiaToolResult {
  readonly text: string
  readonly isError: boolean
}

/**
 * A tool dia offers agents. `name` is unqualified (`plugin_reload`); agents see it as
 * `mcp__dia__<name>`. `input` is a `Schema.Struct` whose JSON Schema is the tool's input schema;
 * `run` receives the decoded input and the {@link ToolScope} of the caller, and is called only for
 * an input that decodes. Build one with {@link diaTool} so `run`'s input is inferred.
 */
export interface DiaTool<S extends ToolInput = ToolInput> {
  readonly name: string
  readonly description: string
  readonly input: S
  run(input: S['Type'], scope: ToolScope): Effect.Effect<DiaToolResult>
}

/** Returns `tool` unchanged; call it so TypeScript infers `run`'s input from `tool.input`. */
export const diaTool = <S extends ToolInput>(tool: DiaTool<S>): DiaTool<S> => tool

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

const text = (value: string, isError = false): DiaToolResult => ({ text: value, isError })

const report = (info: PluginInfo): DiaToolResult => {
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
    case 'Loading':
      return text(`Plugin "${info.name}" is still loading.`)
  }
}

const PluginName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/)).annotate({
  description: 'Name of the plugin: lowercase letters, digits and hyphens.'
})

const Directory = Schema.NonEmptyString.annotate({
  description: 'Absolute path of the folder holding the plugin source.'
})

/** Input of `plugin_reload` and `plugin_clear_override`. */
export const PluginNameInput = Schema.Struct({ name: PluginName })

/** Input of `plugin_override`. */
export const PluginOverrideInput = Schema.Struct({ name: PluginName, directory: Directory })

/**
 * The runs the plugin tools are made for: `plugin`, the name of the plugin running them, and
 * `turnEnded`, which completes when run `runId`'s current turn has ended.
 */
export interface PluginToolCaller {
  readonly plugin: string
  readonly turnEnded: (runId: string) => Effect.Effect<void>
}

/**
 * The three tools an agent uses to change which source a plugin loads from and to reload it:
 * `plugin_override` (set a source folder, then reload), `plugin_reload` and
 * `plugin_clear_override` (return to the bundled copy, then reload). A result with `isError` set
 * tells the agent the plugin did not end up loaded cleanly. Each reload runs in a fiber detached
 * from the calling run, so it completes when the reload ends the run's session. A reload of
 * `caller.plugin` from a run waits for `caller.turnEnded(runId)` and the tool returns at once, so
 * the turn that asked for it ends before the reload interrupts it. Register them once, for run
 * scopes only.
 */
export const makePluginTools = (
  host: PluginToolHost,
  caller: PluginToolCaller
): ReadonlyArray<DiaTool> => {
  const reload = (name: string, scope: ToolScope): Effect.Effect<DiaToolResult> =>
    name === caller.plugin && scope.runId !== undefined
      ? caller
          .turnEnded(scope.runId)
          .pipe(
            Effect.andThen(Effect.logInfo('Reloading the plugin that ran the session', { name })),
            Effect.andThen(host.reload(name)),
            Effect.forkDetach,
            Effect.as(
              text(`Plugin "${name}" runs this session, so it reloads when this turn ends.`)
            )
          )
      : host.reload(name).pipe(Effect.forkDetach, Effect.flatMap(Fiber.join), Effect.map(report))
  return [
    diaTool({
      name: 'plugin_override',
      description:
        "Point a dia plugin at a source folder on disk and reload it, so the plugin runs that folder's code. The folder must hold a plugin.json and resolve to a package with type module.",
      input: PluginOverrideInput,
      run: Effect.fn('PluginTools.override')(function* (input, scope) {
        const result = yield* host.setOverride(input.name, input.directory)
        if (result._tag === 'Rejected') return text(`Override refused: ${result.message}`, true)
        return yield* reload(input.name, scope)
      })
    }),
    diaTool({
      name: 'plugin_reload',
      description:
        'Reload a dia plugin so it runs its current source. If the new version fails, the previous one keeps running and the failure is reported.',
      input: PluginNameInput,
      run: (input, scope) => reload(input.name, scope)
    }),
    diaTool({
      name: 'plugin_clear_override',
      description: 'Return a dia plugin to the copy that ships with dia and reload it.',
      input: PluginNameInput,
      run: Effect.fn('PluginTools.clearOverride')(function* (input, scope) {
        yield* host.clearOverride(input.name)
        return yield* reload(input.name, scope)
      })
    })
  ]
}
