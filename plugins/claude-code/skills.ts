import { directorySkills, pathChanges, readSkills } from '@dia-plugin/skills/directory'
import type { Skill, SkillContext, SkillSource } from '@dia-plugin/skills/registry'
import { Effect, FileSystem, Option, Path, Schema, Stream } from 'effect'

const Install = Schema.Struct({
  scope: Schema.String,
  installPath: Schema.String,
  projectPath: Schema.optionalKey(Schema.String)
})

const InstalledPlugins = Schema.Struct({
  plugins: Schema.Record(Schema.String, Schema.Array(Install))
})

const Settings = Schema.Struct({
  enabledPlugins: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
})

const PluginManifest = Schema.Struct({ name: Schema.NonEmptyString })

const readJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  file: string,
  schema: S,
  fallback: S['Type']
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
      Effect.catch((error) =>
        error._tag === 'PlatformError' && error.reason._tag === 'NotFound'
          ? Effect.succeed(fallback)
          : Effect.as(
              Effect.logWarning('Could not read a Claude Code file', { file, error }),
              fallback
            )
      )
    )
  })

const flat = (lists: ReadonlyArray<ReadonlyArray<Skill>>): ReadonlyArray<Skill> => lists.flat()

const projectDirectories = Effect.fnUntraced(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const walked: Array<string> = []
  let directory = path.resolve(cwd)
  while (true) {
    walked.push(directory)
    if (yield* fs.exists(path.join(directory, '.git')).pipe(Effect.orElseSucceed(() => false))) {
      return walked
    }
    const parent = path.dirname(directory)
    if (parent === directory) return [path.resolve(cwd)]
    directory = parent
  }
})

const projectSkills = (cwd: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path
      const directories = yield* projectDirectories(cwd)
      return Stream.zipLatestAll(
        ...directories.map((directory) =>
          directorySkills({
            directory: path.join(directory, '.claude', 'skills'),
            group: 'Project',
            plugin: Option.none()
          })
        )
      ).pipe(Stream.map(flat))
    })
  )

const enabledPlugins = Effect.fnUntraced(function* (settingsFiles: ReadonlyArray<string>) {
  const settings = yield* Effect.forEach(settingsFiles, (file) => readJson(file, Settings, {}))
  const enabled = new Set<string>()
  for (const { enabledPlugins = {} } of settings) {
    for (const [key, on] of Object.entries(enabledPlugins)) {
      if (on === true) enabled.add(key)
      else enabled.delete(key)
    }
  }
  return enabled
})

const pluginSkills = Effect.fnUntraced(function* (
  installedFile: string,
  settingsFiles: ReadonlyArray<string>,
  cwd: Option.Option<string>
) {
  const path = yield* Path.Path
  const installed = yield* readJson(installedFile, InstalledPlugins, { plugins: {} })
  const enabled = yield* enabledPlugins(settingsFiles)
  const project = Option.map(cwd, (directory) => path.resolve(directory))
  const counts = (install: typeof Install.Type): boolean =>
    install.scope === 'user' ||
    (install.projectPath !== undefined &&
      Option.contains(project, path.resolve(install.projectPath)))
  const installs = Object.entries(installed.plugins).flatMap(([key, entries]) => {
    const install = enabled.has(key) ? entries.find(counts) : undefined
    return install === undefined ? [] : [{ key, install }]
  })
  yield* Effect.logDebug('Listing skills of enabled Claude Code plugins', {
    count: installs.length
  })
  const lists = yield* Effect.forEach(
    installs,
    Effect.fnUntraced(function* ({ key, install }) {
      const manifest = yield* readJson(
        path.join(install.installPath, '.claude-plugin', 'plugin.json'),
        Schema.UndefinedOr(PluginManifest),
        undefined
      )
      const name = manifest?.name ?? key.split('@')[0] ?? key
      return yield* readSkills({
        directory: path.join(install.installPath, 'skills'),
        group: `Plugin › ${name}`,
        plugin: Option.some(name)
      })
    }),
    { concurrency: 8 }
  )
  return flat(lists)
})

const installedPluginSkills = (home: string, context: SkillContext) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path
      const claude = path.join(home, '.claude')
      const installedFile = path.join(claude, 'plugins', 'installed_plugins.json')
      const settingsFiles = [
        path.join(claude, 'settings.json'),
        ...Option.match(context.cwd, {
          onNone: () => [],
          onSome: (cwd) => [
            path.join(cwd, '.claude', 'settings.json'),
            path.join(cwd, '.claude', 'settings.local.json')
          ]
        })
      ]
      return Stream.zipLatestAll(...[installedFile, ...settingsFiles].map(pathChanges)).pipe(
        Stream.mapEffect(() => pluginSkills(installedFile, settingsFiles, context.cwd))
      )
    })
  )

/**
 * The skill sources Claude Code reads under the home directory `home`: `claude-code/user`
 * (`<home>/.claude/skills`), `claude-code/project` (each context's `<cwd>/.claude/skills` and its
 * parents up to the repository root) and `claude-code/plugins` (the skills of every installed
 * plugin that `enabledPlugins` turns on for the context). Each source keeps the `FileSystem` and
 * `Path` it was built with.
 */
export const claudeCodeSources = Effect.fnUntraced(function* (home: string) {
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
  const path = yield* Path.Path
  const user = directorySkills({
    directory: path.join(home, '.claude', 'skills'),
    group: 'Your skills',
    plugin: Option.none()
  })
  const sources: ReadonlyArray<SkillSource> = [
    { id: 'claude-code/user', skills: () => user.pipe(Stream.provideContext(services)) },
    {
      id: 'claude-code/project',
      skills: (context) =>
        Option.match(context.cwd, {
          onNone: () => Stream.make([]),
          onSome: (cwd) => projectSkills(cwd).pipe(Stream.provideContext(services))
        })
    },
    {
      id: 'claude-code/plugins',
      skills: (context) =>
        installedPluginSkills(home, context).pipe(Stream.provideContext(services))
    }
  ]
  return sources
})
