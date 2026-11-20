import { type DiaTool, diaTool, type PluginControl, type PluginInfo } from '@dia/plugin'
import { Effect, Schema } from 'effect'

const problemOf = (info: PluginInfo): string | undefined => {
  switch (info.status._tag) {
    case 'Loaded':
      return info.status.reloadError
    case 'Failed':
    case 'RestartRequired':
      return info.status.message
    case 'Waiting':
      return `waiting for ${info.status.missing.join(', ')}`
    default:
      return undefined
  }
}

const listLine = (info: PluginInfo) => {
  const line = `${info.name}  ${info.status._tag}  ${info.origin}  ${info.root}`
  const problem = problemOf(info)
  return problem === undefined ? line : `${line}\n  ${problem}`
}

const PluginInspectInput = Schema.Struct({
  name: Schema.NonEmptyString.annotate({
    description: 'Name of the plugin, as plugin_list shows it.'
  })
})

/**
 * The Creator-only dia tools over `plugins`: `plugin_list`, one line per plugin with its name,
 * status, origin and source folder, followed by its load problem when it has one; and
 * `plugin_inspect`, one plugin's info and manifest fields as JSON. Register them for Creator run
 * scopes only.
 */
export const makeCreatorTools = (plugins: PluginControl): ReadonlyArray<DiaTool> => [
  diaTool({
    name: 'plugin_list',
    description:
      'List every dia plugin with its status, whether it loads from the bundled copy (default) or an override folder, and its source folder.',
    input: Schema.Struct({}),
    run: Effect.fn('CreatorTools.list')(function* () {
      const list = yield* plugins.list
      yield* Effect.logDebug('Listed plugins for a Creator run', { plugins: list.length })
      return { text: list.map(listLine).join('\n'), isError: false }
    })
  }),
  diaTool({
    name: 'plugin_inspect',
    description:
      "Read one dia plugin's status, source folder, provided services, and the inject, exports and load fields of its plugin.json.",
    input: PluginInspectInput,
    run: (input) =>
      plugins.inspect(input.name).pipe(
        Effect.map((description) => ({
          text: JSON.stringify(description, null, 2),
          isError: false
        })),
        Effect.catchTag('PluginNotFound', () =>
          Effect.succeed({ text: `No plugin named ${input.name}`, isError: true })
        ),
        Effect.catchTag('PluginManifestUnreadable', (error) =>
          Effect.succeed({ text: error.message, isError: true })
        ),
        Effect.tap((result) =>
          Effect.logDebug('Inspected a plugin for a Creator run', {
            plugin: input.name,
            isError: result.isError
          })
        )
      )
  })
]
