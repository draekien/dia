# Skills registry

`plugins/skills` provides a Host service that lists every skill a Claude Code session could load, grouped by where it comes from. Plugins register skill sources for their own lifetime; `skills` stores no skill files. A picker in the renderer lets the user choose skill names. Issue #221, step 1 of ADR-0072 (with #220).

Scope: module (a new `skills` plugin with a host and a renderer entry, contributors in `meta` and `claude-code`, and the org job title editor as the first consumer). Decisions confirmed by the user on 2026-11-08:

1. A source is a provider, as in `deepseek-harness` (`packages/skill/skill/src/index.ts:247-266,390`). `skills` also exports a helper that builds a source from a directory of `SKILL.md` files, as `deepseek-harness` splits `skill` and `skill-filesystem`.
2. A source's skills depend on an optional project directory (`cwd`), as `deepseek-harness` passes `cwd` to `list` (`index.ts:351-367`). Without a `cwd`, project skills are not listed.
3. Sources watch their files, as `skill-filesystem` does, so an open picker updates when a skill is added on disk.
4. The picker replaces the skills textarea in the org job title editor through `useProvided`, keeping the textarea when `skills` is not loaded. `org` imports `@dia-plugin/skills` until #222 moves the editor to `agent-definitions`.
5. `claude-code` lists only installed plugins that `enabledPlugins` turns on.

Out of scope: passing a job title's `skills` to `Options.skills` (#222), refusing a session that names a missing skill (#222), writing skill files, a Settings page for skills. No consumer passes `cwd` in this issue, so `claude-code/project` is exercised by tests only.

## Current state (read at `ac7fdc3`)

| Location | Holds |
|---|---|
| `plugins/meta/host.ts:8`, `plugins/meta/meta-repo.ts:7-16,55-59,101` | the meta repo at `<ctx.dataDir>/repo`; `plugin/.claude-plugin/plugin.json` with name `dia-meta`; `forNewSession` passes `<repo>/plugin` to sessions as a local plugin. `plugin/skills/` is not created |
| `plugins/claude-code/session.ts:503-521` | `query` options: no `settingSources` (SDK default: user, project, local) and no `skills` |
| `plugins/org/domain.ts:40-46,58,75` | `JobTitle.skills: ReadonlyArray<string>`; empty means every skill |
| `plugins/org/job-title-editor.tsx:46,59,100,295` | `Draft.skills` is text, one name per line; saved through `lines(draft.skills)` |
| `plugins/mcp/editor.ts`, `plugins/org/job-title-editor.tsx:220` | a renderer component shared through a `ServiceKey` and read with `useProvided` |
| `src/host/plugins/plugin-exports.test.ts:60-75` | an exported module, and every file it imports, may import only `effect`, `@dia/plugin`, `@dia-plugin/*` exports and relative `.ts` files |
| `node_modules/effect/src/FileSystem.ts:375,1071-1090` | `FileSystem.watch(path, { recursive })` emits `Create`, `Update`, `Remove`; the Node backend passes `recursive` to `fs.watch` |
| `package.json` | no YAML parser |

Agent SDK facts (SDK 0.3.311):

| Fact | Source |
|---|---|
| `Options.skills: string[] \| 'all'`; names match the `SKILL.md` `name` or the directory name, or `plugin:skill`. `directory.ts` lists user and project skills by directory name, which is accepted whatever the frontmatter `name` | `sdk.d.ts:2327-2347`; code.claude.com/docs/en/agent-sdk/skills.md |
| In a plugin, the `SKILL.md` frontmatter `name` sets the part after `plugin:`; it defaults to the directory name | code.claude.com/docs/en/skills.md |
| Project skills are read from `<cwd>/.claude/skills` and each parent directory up to the repository root | code.claude.com/docs/en/agent-sdk/claude-code-features.md |
| Installed plugins are recorded in `~/.claude/plugins/installed_plugins.json` (`{ version, plugins: { "<name>@<marketplace>": [{ scope, installPath, version, ... }] } }`, fields named, no schema); `enabledPlugins` in `settings.json` turns each on | code.claude.com/docs/en/plugins/loading.md; observed on disk 2026-11-08 |

## Modules

```
plugins/skills/
  plugin.json          name "skills", api "0.0.34", category "feature", host "host.ts",
                       renderer "renderer.ts", load "eager",
                       exports ["registry.ts", "directory.ts", "picker.ts"]
  registry.ts          export @dia-plugin/skills/registry: Skill, SkillContext, SkillSource,
                       SkillSourceIdTaken, SkillSourceRegistry, SkillSourceRegistryKey
  directory.ts         export @dia-plugin/skills/directory: SkillDirectory, readSkills, directorySkills,
                       directorySource, pathChanges
  frontmatter.ts       internal: reads `name` and `description` from a SKILL.md
  make-registry.ts     internal: the registry state, `register`, `skills`
  calls.ts             internal: WatchSkills
  host.ts              internal: makes the registry, provides the key, serves WatchSkills
  picker.ts            export @dia-plugin/skills/picker: SkillPickerProps, SkillPickerKey
  skill-picker.tsx     internal: the picker component
  renderer.ts          internal: provides SkillPickerKey
plugins/meta/host.ts         registers the meta repo's skills directory
plugins/claude-code/skills.ts  internal: the user, project and installed-plugin sources
plugins/claude-code/host.ts  registers them
plugins/org/job-title-editor.tsx  uses the picker when provided
```

Add `registry.ts`, `directory.ts` and `picker.ts` of `plugins/skills` to `include` in `tsconfig.plugin-exports.json` and `tsconfig.web.json`, and `calls.ts` to `tsconfig.web.json`; `plugins/**/*.tsx` already covers `skill-picker.tsx`. `directory.ts` imports only `effect` and `./frontmatter`, so it passes `plugin-exports.test.ts`. Every export carries JSDoc.

## Interface

### `registry.ts`

```ts
/** A skill a session can load. `name` is the name `Options.skills` takes; `group` is the heading the picker lists it under. */
export const Skill = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.String,
  group: Schema.NonEmptyString
})
export type Skill = typeof Skill.Type

/** What a source's skills depend on: the project directory a session would run in, if any. */
export interface SkillContext {
  readonly cwd: Option.Option<string>
}

/**
 * A provider of skills. `id` names the source in the registry. `skills(context)` emits the
 * source's current skills at once and again whenever they change; it never fails.
 */
export interface SkillSource {
  readonly id: string
  readonly skills: (context: SkillContext) => Stream.Stream<ReadonlyArray<Skill>>
}

/** `register` refused `id`: another source holds it. */
export class SkillSourceIdTaken extends Schema.TaggedError<SkillSourceIdTaken>()(
  'SkillSourceIdTaken',
  { id: Schema.String }
) {}

/**
 * The skills plugin's registry. `register(source)` adds `source` until the calling scope closes;
 * call it inside `whenProvided([SkillSourceRegistryKey], ...)`. It fails with
 * `SkillSourceIdTaken` when another source holds `source.id`. `skills(context)` emits every
 * registered source's skills for `context`, sorted by group then name, at once and on each change.
 */
export interface SkillSourceRegistry {
  readonly register: (source: SkillSource) => Effect.Effect<void, SkillSourceIdTaken, Scope.Scope>
  readonly skills: (context: SkillContext) => Stream.Stream<ReadonlyArray<Skill>>
}

/** The key `skills` provides its registry under. */
export const SkillSourceRegistryKey = ServiceKey.make('skillSourceRegistry', isSkillSourceRegistry)
```

`isSkillSourceRegistry` checks that `register` and `skills` are functions, following `plugins/org/service.ts:92-116`.

### `directory.ts`

```ts
/**
 * Where a directory's skills come from and how they are named. `group` is the picker heading;
 * `plugin`, when set, prefixes each name as `<plugin>:`.
 */
export interface SkillDirectory {
  readonly directory: string
  readonly group: string
  readonly plugin: Option.Option<string>
}

/**
 * The skills in `directory` now: one per subdirectory that holds a `SKILL.md`. Each is named by
 * its subdirectory, or `<plugin>:<frontmatter name or subdirectory>` when `plugin` is set. `[]`
 * when `directory` does not exist or cannot be read. Use it for a directory that changes only
 * when another watched file changes, such as a versioned plugin install.
 */
export const readSkills: (
  options: SkillDirectory
) => Effect.Effect<ReadonlyArray<Skill>, never, FileSystem.FileSystem | Path.Path>

/** `readSkills(options)` when its watcher is installed, and again after each change under `directory`. */
export const directorySkills: (
  options: SkillDirectory
) => Stream.Stream<ReadonlyArray<Skill>, never, FileSystem.FileSystem | Path.Path>

/** A source with id `id` whose skills are `directorySkills(options)` for every context. */
export const directorySource: (
  id: string,
  options: SkillDirectory
) => Effect.Effect<SkillSource, never, FileSystem.FileSystem | Path.Path>

/**
 * Emits once when its watcher is installed, then once after changes at `path` (recursive for a
 * directory) pause for `Duration.millis(200)`. While `path` does not exist it watches the parent
 * directory non-recursively, emits nothing for siblings, and switches to `path` when an event names
 * `basename(path)`; if the parent does not exist either it emits once and ends. When `path` is
 * removed while watched, it follows `path` again as a missing path. Exported for sources that
 * follow files other than a skills directory, such as `claude-code`'s settings files.
 */
export const pathChanges: (
  path: string
) => Stream.Stream<void, never, FileSystem.FileSystem | Path.Path>
```

`directorySource` captures the `FileSystem` and `Path` services, so its `skills` stream needs no services.

### `calls.ts`

```ts
/** Streams the skills for an optional project directory. */
export const WatchSkills = Rpc.make('WatchSkills', {
  payload: { cwd: Schema.optionalKey(Schema.String) },
  success: Schema.Array(Skill),
  stream: true
})
```

### `picker.ts`

```ts
/**
 * Props of the skill picker. `label` is the accessible name of its search box; the picker's
 * search box takes no external `<label htmlFor>`. `value` is the chosen skill names; `onChange`
 * receives the next list. `cwd`, when set, adds that project's skills.
 */
export interface SkillPickerProps {
  readonly label: string
  readonly value: ReadonlyArray<string>
  readonly onChange: (value: ReadonlyArray<string>) => void
  readonly cwd?: string
}

/** The skill picker `skills` provides. Read it with `useProvided(SkillPickerKey)`; `undefined` while not provided. */
export const SkillPickerKey = ServiceKey.make(
  'skillPicker',
  (value): value is ComponentType<SkillPickerProps> => typeof value === 'function'
)
```

## Behaviour

**Registry.** The state is one `SubscriptionRef<ReadonlyMap<string, SkillSource>>`. `register` is `Effect.acquireRelease` of a `modifyEffect` that fails with `SkillSourceIdTaken` when the id is held, and a release that deletes the entry only if it is still the same source. `skills(context)` is `SubscriptionRef.changes(ref)` (which emits the current map first) with `Stream.switchMap((entries) => entries.size === 0 ? Stream.make([]) : Stream.zipLatestAll(...[...entries.values()].map((source) => source.skills(context))))`, flattened, sorted by `group` then `name`, and passed through `Stream.changesWith` so a list equal to the one before it is not emitted again. `zipLatestAll` takes its streams as arguments and waits for each to emit once, which every source does at once. A reload closes the old plugin scope, which releases its source, before the new setup registers the same id, so the id is free (`src/shared/plugin/plugin-registry.ts`, `closePlugin` then `open`). When `skills` unloads, `followHost` emits `None` and `SkillPickerKey` is withdrawn, so org shows the textarea; `followHost` subscribes again when `skills` is serving. Editing an `@dia-plugin/skills/*` module in development reloads its importers `meta`, `claude-code` and `org`, as an edit to `@dia-plugin/mcp/*` reloads `org`.

**Names.** A subdirectory without a `SKILL.md` is skipped. Without `plugin`, the name is the subdirectory name. With `plugin`, it is `<plugin>:<name>`, where `<name>` is the frontmatter `name`, or the subdirectory name when absent. `description` is the frontmatter `description`, or `""`. Two sources may list the same name; the picker shows both rows.

**Frontmatter.** `frontmatter.ts` strips a leading byte order mark, splits lines on `\r?\n`, reads the block between a first line `---` and the next `---` (each compared after trimming trailing whitespace), and returns `name` and `description` when each is a plain scalar, a single- or double-quoted scalar, or a block scalar (`>`, `>-`, `|`, `|-`). Any other form yields no value for that key. A file whose frontmatter cannot be read still lists its skill, with a logged warning.

**Errors.** A source's stream does not fail: a read error on one directory logs a warning and that directory contributes `[]` until its next change.

**Contributors.**

| Plugin | Source id | Group | Skills |
|---|---|---|---|
| `meta` | `meta` | `Meta repo` | `directorySource('meta', { directory: <dataDir>/repo/plugin/skills, plugin: Some('dia-meta') })` |
| `claude-code` | `claude-code/user` | `Your skills` | `directorySource` of `<home>/.claude/skills`, no plugin |
| `claude-code` | `claude-code/project` | `Project` | with `cwd`: `directorySkills` of `<dir>/.claude/skills` for `cwd` and each parent up to the first directory that holds `.git`, or `cwd` alone when none does, each name once, from the directory nearest `cwd`; without `cwd`: `[]` |
| `claude-code` | `claude-code/plugins` | `Plugin › <name>` | `pathChanges` of `<home>/.claude/plugins/installed_plugins.json`, `<home>/.claude/settings.json` and, with `cwd`, `<cwd>/.claude/settings.json` and `<cwd>/.claude/settings.local.json`; on each change, `readSkills` of `<installPath>/skills` for every install that counts for the context (below) and whose key is `true` in `enabledPlugins`, with `<name>` the `name` in `<installPath>/.claude-plugin/plugin.json`, or the key before `@`. Install directories are not watched: an install changes only through a new `installPath` or `version` in `installed_plugins.json` |

`plugins/claude-code/skills.ts` exports `claudeCodeSources(home: string): Effect<ReadonlyArray<SkillSource>, never, FileSystem | Path>` (the three sources above); `host.ts` passes `os.homedir()`. Tests pass a temp directory, so no test reads the real `~/.claude` (`.claude/rules/tests-run-without-claude.md`).

Each contributor builds its sources once in its outer setup, under the `NodeServices.layer` that `meta/host.ts` and `claude-code/host.ts` already provide, then runs `for (const source of sources) yield* ctx.whenProvided([SkillSourceRegistryKey], ({ skillSourceRegistry }) => skillSourceRegistry.register(source))`. One `whenProvided` per source means a refused id does not release the other sources (`src/shared/plugin/api.ts:76-90`: a failed setup closes its child scope and runs again only after the key is provided again). A refused `register` is logged by the kernel as a failed `whenProvided` setup. Installed plugin skills are read only from `<installPath>/skills`; a plugin whose manifest names another skills path is listed without those skills.

An install from `installed_plugins.json` counts for a context when its `scope` is `user`, or its `scope` is `project` or `local` and its `projectPath` is `cwd` (compared after `path.resolve`). `enabledPlugins` is read from `~/.claude/settings.json`, then `<cwd>/.claude/settings.json`, then `<cwd>/.claude/settings.local.json`, a later file's entry replacing an earlier one's, matching the SDK default `settingSources` of user, project and local.

**Host entry.** `host.ts` makes the registry, provides `SkillSourceRegistryKey`, and serves `WatchSkills` as `registry.skills({ cwd: Option.fromNullishOr(cwd) })`.

## Picker

`renderer.ts` builds an `Atom.family` keyed by `cwd` from its own `ctx`, each atom `followHost(ctx, WatchSkills, cwd === undefined ? {} : { cwd })` (`followHost` calls `payloadSchema.make`, and `optionalKey` rejects `{ cwd: undefined }`), as `makeServersAtom(ctx)` in `plugins/mcp/settings-page.tsx:24`. It provides `SkillPickerKey` as `(props) => createElement(SkillPicker, { ...props, skillsFamily })`, so a consumer passes only `SkillPickerProps`.

`skill-picker.tsx` renders a shadcn `Command` (exported by `@dia/renderer-plugin`) with a search input and one `CommandGroup` per `group`, in a list with a fixed `max-h-64` that scrolls. `label` is passed to `Command`, which renders it as the visually hidden `<label>` of its input: cmdk sets the input's `id` and `aria-labelledby` itself (`node_modules/cmdk/dist/index.mjs`, `Input`), so an `id` from the consumer cannot reach the input. Each `CommandItem` has `value={`${group}/${name}`}` and `keywords={[name, description]}`, shows a check when its name is in `value`, the name in mono and the description truncated, and toggles the name on select; two rows with one name both show the check. Names in `value` that no skill has are listed first in a `Missing` group as `<name> (missing)`, so they can be removed (ADR-0072 "Missing references"). Under the list: `None selected: sessions get every skill.` while `value` is empty. While loading: a `Skeleton`; when the host entry is not serving: `The skills plugin's host entry is not loaded.`

**Org.** `job-title-editor.tsx` reads `useProvided(SkillPickerKey)`. When defined, it renders its own `Field` with `<Label>Skills</Label>` (as its MCP servers field does when no editor is provided) and the picker with `label="Skills"`, `value={lines(draft.skills)}` and `onChange={(next) => set('skills')(next.join('\n'))}`, and no caption (the picker's `None selected` line replaces it); otherwise the existing textarea. Enter in the picker's search input selects the highlighted row and does not submit the form, because cmdk calls `preventDefault` on Enter. `Draft`, `editOf` and storage do not change.

## Logging

`register`: `logInfo` with `id`; refusal: `logWarning` with `id`. Source removed: `logInfo`. Directory read error and unreadable frontmatter: `logWarning` with the path. `pathChanges` watching a parent because `path` is missing: `logDebug` with the path. `claude-code/plugins` re-listing: `logDebug` with the count of enabled installs.

`SkillContext`, `SkillSource`, `SkillDirectory` and `SkillPickerProps` are interfaces, not schemas, because they hold functions or an `Option` and never cross a process boundary; `Skill` and the `WatchSkills` payload cross it and are schemas.

## Tests

| Criterion | Test |
|---|---|
| 1. meta and user skills listed under their groups | `skills` and `meta` host setups loaded through `makePluginRegistry` (as `plugins/mcp/host.test.ts`), plus `claudeCodeSources(tempHome)` registered into the same registry; `WatchSkills` emits `dia-meta:<dir>` in `Meta repo` and `<dir>` in `Your skills` |
| 2. unloading `meta` removes its skills | same harness; after `unload('meta')` the next emission has no `Meta repo` row |
| 3. a new `SKILL.md` appears without reopening | `directorySkills` over a temp directory; writing a `SKILL.md` produces an emission containing it, awaited with a 5 s timeout (real `fs.watch` and debounce, not `TestClock`) |
| 4. enabled plugins only, named `plugin:skill` | `claudeCodeSources(tempHome)` with two user-scope installs, one enabled, and one project-scope install for another project |
| 5. project skills only with `cwd` | `claudeCodeSources(tempHome)` `claude-code/project` with and without `cwd`, including a parent directory that holds `.git` |
| 6. picked names are saved | `job-title-editor` test with a fake `SkillPickerKey` provider; selecting a name sends it in `EditJobTitle`; Enter in the search input does not submit |
| 7. duplicate id refused | `make-registry` test |

Also: reloading `meta` registers `meta` again without `SkillSourceIdTaken`; `frontmatter.ts` for each scalar form and for LF, CRLF and a byte order mark; a `SKILL.md` with unreadable frontmatter is still listed; `pathChanges` on a missing path does not emit for a sibling; the picker lists `(missing)` names; the registry drops a source when its scope closes.

## Design Rationale

**One stream per source instead of `list` plus `changes`.** A source whose skills depend on `cwd` would need `changes(context)` as well as `list(context)`; a single `skills(context)` stream carries both and cannot emit a change without the list it changed to.

**`group` on `Skill`, not on the source.** `claude-code`'s installed plugins change while it is loaded; one source whose skills carry their plugin's group avoids registering and unregistering a source per plugin.

**A frontmatter reader instead of a YAML dependency.** An exported module may import only `effect` and relative files (`plugin-exports.test.ts`), and a survey of 236 installed `SKILL.md` files found only plain, `>`, `>-` and double-quoted descriptions.

## Rejected Alternatives

- **A tagged union `Directory | Provider` in the registry**: two cases in the registry for one concept; rejected by the user.
- **One source per dia project**: a definition could pick a skill that only one project has.
- **Scan on each read without watching**: rejected by the user in favour of `skill-filesystem`'s behaviour.

## Refinement Record

### Round 1

- *Correctness* blocker: `Schema.TaggedErrorClass` does not exist in Effect v4; now `Schema.TaggedError`, as `plugins/mcp/registry.ts:26`. Applied.
- *Correctness* blocker: `plugin.json` lacked `api` and `category`, which `PluginManifest` requires (`src/shared/plugin/manifest.ts:100-108`); now `"api": "0.0.34", "category": "feature"`. Applied.
- *Correctness* major: one `whenProvided` for three `claude-code` sources would release all three when one id is refused; now one `whenProvided` per source. Applied.
- *Correctness* major: `Stream.zipLatestAll` takes streams as arguments (`Stream.ts:5838`) and has no zero case; now spread, with `Stream.make([])` for no sources. Applied.
- *Correctness* major: `optionalKey` rejects `{ cwd: undefined }` through `followHost`'s `payloadSchema.make`; the picker now omits `cwd`. Applied.
- *Correctness* minor: `Stream.debounce` emits after a pause, not at a rate; reworded with `Duration.millis(200)`. Applied.
- *Correctness* minor: a change between the first emission and the watcher install was lost; `pathChanges` now emits first when `onReady` fires. Applied.
- *Correctness* minor: project- and local-scope installs carry a `projectPath` (53 of 83 installs on disk, 2026-11-08); an install now counts only for its own project, and `settings.local.json` is read too. Applied.
- *Project rules* minor ×3: interfaces-not-schemas note, `SkillDirectory` field docs, logging of the parent-watch fallback and plugin re-listing. Applied.
- *Avoid Hasty Abstractions* minor: drop `directorySource`. Rejected: the user confirmed `directorySource` as the shared helper, and it removes the services requirement for both `meta` and `claude-code/user`.
- *Information Hiding* minor: do not export `pathChanges`. Rejected: `claude-code/plugins` follows three JSON files with the same missing-path handling; folding them into `directorySkills` would give it a parameter only one caller uses (Strategic Programming).
- *Define Errors Out of Existence* minor: `NonEmptyString` for `SkillSource.id`. Rejected: `SkillSource` is a TypeScript interface, not a schema; contributors pass literal ids.

### Round 2

- *Correctness* major: CRLF and a byte order mark broke the `---` match; the reader now strips the mark, splits on `
?
` and trims delimiter lines, with tests. Applied.
- *Correctness* major: the missing-path fallback could watch a repository root recursively; the parent watch is now non-recursive and filtered to `basename(path)`. Applied.
- *Design* major: about 30 recursive watchers over immutable plugin cache directories, rebuilt on every settings change. Applied with a different fix: instead of a `watch: boolean` parameter that one caller uses (Strategic Programming), `directory.ts` exports `readSkills`, and `claude-code/plugins` calls it on each change to its JSON files.
- *Project rules* major: the test plan read the real `~/.claude` and loaded `claude-code`'s host, which needs the `claude` binary; `claudeCodeSources(home)` now takes the home directory, tests use a temp home, and the watch test waits with a timeout. Applied.
- *Correctness* major: the provided component had no `ctx` for `followHost`, and the label target was unclear; `renderer.ts` now builds the atom family from `ctx` and provides a wrapper, and `id` goes on `CommandInput`. Applied.
- *Correctness* minor: duplicate names shared one cmdk `value`; each item now has `value={group/name}`. Applied.
- *Project rules* minor: the org `Field`/`Label` wiring, the scroll height and Enter in the search input were unstated. Applied.
- *Design* minor: no consumer passes `cwd`; noted under Out of scope. Applied.
- *Project rules* minor: unreadable frontmatter was untested; added. Applied.

### Round 3

- *Project rules / Information Hiding* major: an array of sources did not fit one `whenProvided` per source, and each setup re-provided `NodeServices.layer`; sources are now built once in the outer setup and registered in a loop. Applied.
- *Lifecycle* minor: reload ordering, `skills` unloading and the reload test were unstated. Applied.
- *Correctness* minor: `sdk.d.ts:2335` accepts the frontmatter `name` or the directory name for user and project skills; the fact row now says so. Applied.
- *Project rules* minor: `tsconfig.web.json` already includes `plugins/**/*.tsx`. Applied.
- *Behaviour* minor: an edit to a `skills` export reloads its importers in development. Applied as one sentence.
- Unverified (round 3): a plugin manifest may name a custom skills path; recorded as a limitation under Contributors.
