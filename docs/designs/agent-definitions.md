# Agent definitions

`plugins/agent-definitions` provides a Host registry of agent definitions: the session setup a hired agent or the Executive assistant runs with. Plugins contribute definitions for their own lifetime; `agent-definitions` stores the user's own definitions and the user's edits to contributed definitions. `org` contributes its built-in job titles, keeps what only the org uses (`enabled`, the built-in kind), hands its `job_titles` rows over to `agent-definitions` and `mcp`, and refuses to start a session whose definition names an MCP server or skill that resolves to nothing. Issue #222, step 2 of ADR-0072.

Scope: module (a new `agent-definitions` plugin with a host only; changes in `org`, `mcp`, `skills`, `meta`, `claude-code`, `SessionToolOptions` and `HostPluginContext`). Decisions confirmed by the user on 2026-11-09:

1. One PR for the extraction, the migration and the missing-reference rules.
2. `agent-definitions` stores the user's edits to a contributed definition as an override with the same id. A contributed definition's name cannot change.
3. `org` hands its rows over: both registries get import calls; `org` imports on start and then drops its copy. No plugin reads another plugin's database file.
4. `enabled` and the built-in kind stay in `org`. A definition has `id`, `name`, `jobDescription`, `skills`, `permissions`, `mcpServers`, `bypassOptIn`, `model`, `thinkingLevel`.
5. Delete stays in the org's Job titles page and keeps refusing with `JobTitleHasHires`. No Settings page for agent definitions.
6. `mcp` provides `McpServerPickerKey`, used by the job title editor; a textarea of names is the fallback.
7. When the Executive assistant definition names a missing item, the assistant does not attach and the org dashboard shows the missing names.
8. A refused issue keeps the missing names in a field on the issue, cleared when it leaves `triage`.
9. A skill source can name a local plugin directory; `skills` resolves names to `{ missing, pluginPaths }` and sessions load those paths.

`org` contributes the seven built-in job titles and the Executive assistant. The Executive assistant moves to `assistant` in #224 (ADR-0072 lists `assistant` as its contributor).

Out of scope: a Settings page for agent definitions, the `issues` plugin (#223), the `assistant` plugin (#224), writing skill files, resetting an override to the contributed default.

## Success criteria

1. After the migration from an `org.db` with an edited built-in, a copied job title and two inline `github` servers with different configs: every job title lists with the same fields; `mcp` lists `github` and `github-2`; the second definition names `github-2`.
2. Every migrated job title is hireable, and its session opens with the same MCP servers as before, plus `Options.skills` set to its skills.
3. Re-running the handover after a crash between import and drop creates no duplicates.
4. After the MCP server a definition names is deleted, the next dispatch for that definition opens no session; the issue moves to `triage` with `missing` naming the server; the Triage card shows it.
5. The same refusal for a skill no source lists.
6. A `dia-meta:*` skill on a job title adds meta's plugin directory to the session's `pluginPaths`.
7. The editor's MCP field picks registered servers by name and shows a missing name as `<name> (missing)`; the Skills field does the same (`plugins/skills/skill-picker.tsx:49` already lists chosen names no source has as missing).
8. Saving a built-in's edits keeps its name, and the edits after an app restart.
9. When the Executive assistant definition names a missing item, the assistant does not attach, and the dashboard shows the missing names.

## Current state (read at `origin/main` after #227)

| Location | Holds |
|---|---|
| `plugins/org/domain.ts:52-82` | `JobTitle` with `builtIn`, `enabled`, `mcpServers: McpServers` (inline configs), `skills: string[]`; `JobTitleEdit` |
| `plugins/org/org.ts:110-412` | `job_titles` rows; `jobTitles`, `watchJobTitleChanges` (a PubSub), `setJobTitleEnabled`, `copyJobTitle`, `editJobTitle`, `deleteJobTitle` (refuses built-ins and `JobTitleHasHires` in one transaction), `hire` (refuses disabled and the EA) |
| `plugins/org/migrations.ts:83-122,196-213,255-300,324-333` | built-ins seeded from `BUILT_IN_JOB_TITLES` (`allow []`, `deny seed.deny`), then `allowIssueToolsOnBuiltIns` adds `ISSUE_TOOLS` to `allow`; the EA from `EXECUTIVE_ASSISTANT` (`allow ROUTING_TOOLS`); all with `skills []`, `mcp_servers {}`, `bypass_opt_in 0`, `model NULL`, `thinking_level 'medium'`. `hired_agents.job_title_id REFERENCES job_titles`; `objectives.assignee`, `issues.assignee`, `issue_comments.author` reference `hired_agents` with `ON DELETE SET NULL` |
| `src/host/plugins/database.ts:49` | plugin databases open with `PRAGMA foreign_keys = ON` |
| `plugins/org/dispatcher.ts:168-174,272-345,398-418` | `StartContext.jobTitle`; `openSession` with `pluginPaths: []`, `tools: { permissions, mcpServers }`; skills never passed |
| `plugins/org/assistant.ts:76-80,140-261` | attaches while the built-in EA is enabled (`attachNow`, also from `startOver`); follows `watchJobTitleChanges` |
| `plugins/org/host.ts:57-75,186-215,262-300` | `readWorkView` = `work.snapshot` + `dispatcher.live`; `makeOrg` runs before any `whenProvided`; `ReadOrg`; job title RPCs |
| `plugins/org/work.ts:46-71,278-287,366,536,716,730,739` | `OrgEvent`; `IssueRuns`; the five places that write `status` |
| `plugins/mcp/make-registry.ts`, `plugins/mcp/host.ts`, `plugins/mcp/store.ts` | `makeRegistry(initial)`; `replaceUser(servers, persist)` with `persist` from the host; `writeUserServers` replaces `user_servers` |
| `plugins/skills/registry.ts`, `plugins/skills/directory.ts:20-24`, `plugins/meta/host.ts:14-18` | `SkillSource { id, skills(context) }`; `SkillDirectory { directory, group, plugin }`; meta's source is `directorySource('meta', { directory: <repo>/plugin/skills, … })` |
| `plugins/meta/meta-repo.ts:108` | meta's own sessions load `<repo>/plugin` (`PLUGIN_DIRECTORY`) |
| `src/shared/domain/session-tools.ts:21-25` | `SessionToolOptions { permissions, mcpServers }` |
| `plugins/claude-code/session-tool-options.ts:22,44-46` | `NO_TOOLS`; maps `SessionToolOptions` to `Pick<Options, 'allowedTools' \| 'disallowedTools' \| 'settings' \| 'mcpServers'>` |
| `sdk.d.ts:2315-2347` (installed SDK) | `settingSources` omitted loads user, project and local settings; `Options.skills: string[] \| 'all'` filters discovered skills |

## Modules

```
plugins/agent-definitions/
  plugin.json        name "agent-definitions", api "0.0.35", category "feature", host "host.ts",
                     load "eager", exports ["registry.ts"]
  registry.ts        export @dia-plugin/agent-definitions/registry
  store.ts           internal: migrations; read (skips and logs undecodable rows), insert, upsert, delete
  make-registry.ts   internal: the registry over stored definitions and contributions
  host.ts            internal: opens the database, provides the key
plugins/mcp/
  plugin.json        exports + "picker.ts"
  registry.ts        + importServers (and in MEMBERS)
  make-registry.ts   makeRegistry(initial, writeUsers); + importServers
  host.ts            passes writeUserServers to makeRegistry
  picker.ts          export: McpServerPickerProps, McpServerPickerKey
  server-picker.tsx  internal: the picker
  renderer.ts        + provides McpServerPickerKey
plugins/skills/
  registry.ts        + SkillSource.pluginPath, SkillResolution, resolve (and in MEMBERS)
  directory.ts       DirectorySourceOptions; directorySource copies pluginPath
  make-registry.ts   + resolve
plugins/meta/host.ts             passes pluginPath = <repo>/plugin
src/shared/domain/session-tools.ts   + skills
plugins/claude-code/session-tool-options.ts  + skills; session.ts logs it
plugins/org/
  domain.ts          JobTitle built from AgentDefinition; MissingReference; Issue.missing
  built-in-job-titles.ts  + BUILT_IN_DEFINITIONS, BUILT_IN_KIND_BY_ID
  org.ts             job titles read from the registry ref; enabled in job_title_settings
  handover.ts        internal: moves job_titles_handover rows into agent-definitions and mcp
  session-tools.ts   internal: SessionTools, makeSessionTools, the SessionToolsResult cases
  dispatcher.ts, assistant.ts, work.ts, host.ts, migrations.ts
  job-title-editor.tsx, objective-screen.tsx, dashboard.tsx
  org-host.fake.tsx and the org tests that build JobTitle, Issue or SessionToolOptions
docs/glossary.md     + agent definition, job title
docs/reasoning/      + the SQLite parent-table rebuild finding (see "Migration")
```

The `@dia-plugin/*` aliases already cover the new plugin in `tsconfig.base.json`, `electron.vite.config.ts` and `vitest.config.ts`; add the new exported files to `tsconfig.plugin-exports.json` and `tsconfig.web.json` as #221 did. No `DiaRpcs` change, so `PROTOCOL_VERSION` stays. Every export carries JSDoc.

## Interface

### `plugins/agent-definitions/registry.ts`

```ts
/** Identifies an agent definition; a UUID. A contributed definition keeps the same id on every install. */
export const AgentDefinitionId = Uuid.pipe(Schema.brand('AgentDefinitionId'))
export type AgentDefinitionId = typeof AgentDefinitionId.Type

/** Trimmed, 1–40 characters; unique across listed definitions ignoring ASCII case. */
export const AgentDefinitionName = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(40)),
  Schema.brand('AgentDefinitionName')
)
export type AgentDefinitionName = typeof AgentDefinitionName.Type

/**
 * The setup a session runs with. `skills` are names as `Options.skills` takes them; empty means
 * every skill. `mcpServers` are names in the `mcp` registry. `model` null means the first model
 * the backend lists.
 */
export const AgentDefinition = Schema.Struct({
  id: AgentDefinitionId,
  name: AgentDefinitionName,
  jobDescription: Schema.String,
  skills: Schema.Array(Schema.String),
  permissions: PermissionRules,
  mcpServers: Schema.Array(Schema.String),
  bypassOptIn: Schema.Boolean,
  model: Schema.NullOr(Schema.NonEmptyString),
  thinkingLevel: ThinkingLevel
})
export type AgentDefinition = typeof AgentDefinition.Type

/** A change to a definition's fields other than `id`; an absent field is left as it is. */
export const AgentDefinitionEdit = AgentDefinition.mapFields((fields) =>
  Struct.map(Struct.omit(fields, ['id']), Schema.optionalKey)
)
export type AgentDefinitionEdit = typeof AgentDefinitionEdit.Type

/** The user added the definition. */
export const UserSource = Schema.TaggedStruct('User', {})
/** The plugin named `plugin` contributes the definition. */
export const PluginSource = Schema.TaggedStruct('Plugin', { plugin: Schema.NonEmptyString })
/** Who added a definition. */
export const DefinitionSource = Schema.Union([UserSource, PluginSource])

/** A listed definition. `edited` is true when the user's override replaces a contributed one's fields. */
export const RegisteredDefinition = Schema.Struct({
  definition: AgentDefinition,
  source: DefinitionSource,
  edited: Schema.Boolean
})

/** `register` refused `id`: another source holds it. */
export class AgentDefinitionIdTaken extends Schema.TaggedError<AgentDefinitionIdTaken>()('AgentDefinitionIdTaken', { id: AgentDefinitionId }) {}
/** Another listed definition has `name`, ignoring ASCII case. */
export class AgentDefinitionNameTaken extends Schema.TaggedError<AgentDefinitionNameTaken>()('AgentDefinitionNameTaken', { name: AgentDefinitionName }) {}
/** No listed definition has `id`. */
export class AgentDefinitionNotFound extends Schema.TaggedError<AgentDefinitionNotFound>()('AgentDefinitionNotFound', { id: AgentDefinitionId }) {}
/** `edit` changed the name of contributed definition `id`. */
export class ContributedDefinitionRenamed extends Schema.TaggedError<ContributedDefinitionRenamed>()('ContributedDefinitionRenamed', { id: AgentDefinitionId }) {}
/** `delete` targeted contributed definition `id`. */
export class ContributedDefinitionDeleted extends Schema.TaggedError<ContributedDefinitionDeleted>()('ContributedDefinitionDeleted', { id: AgentDefinitionId }) {}

/** Every agent definition dia knows. Read it with `ctx.whenProvided([AgentDefinitionRegistryKey], …)`. */
export interface AgentDefinitionRegistry {
  /** Lists `definition` for plugin `plugin` (pass `ctx.name`) until the calling scope closes. Call inside `whenProvided`. */
  readonly register: (
    definition: AgentDefinition,
    plugin: string
  ) => Effect.Effect<void, AgentDefinitionIdTaken | AgentDefinitionNameTaken, Scope.Scope>
  /** Every listed definition: contributed ones first, then by name. */
  readonly list: Effect.Effect<ReadonlyArray<RegisteredDefinition>>
  /** `list` now, then again after each change. */
  readonly changes: Stream.Stream<ReadonlyArray<RegisteredDefinition>>
  /** Stores a new user definition with a fresh id and returns it. */
  readonly create: (
    fields: Omit<AgentDefinition, 'id'>
  ) => Effect.Effect<AgentDefinition, AgentDefinitionNameTaken>
  /** Applies `edit` to the stored user definition, or to the override of a contributed one. */
  readonly edit: (
    id: AgentDefinitionId,
    edit: AgentDefinitionEdit
  ) => Effect.Effect<
    AgentDefinition,
    AgentDefinitionNotFound | AgentDefinitionNameTaken | ContributedDefinitionRenamed
  >
  /** Deletes a user definition. */
  readonly delete: (
    id: AgentDefinitionId
  ) => Effect.Effect<void, AgentDefinitionNotFound | ContributedDefinitionDeleted>
  /** Stores `definitions` as user definitions with their ids; an id already stored is skipped. Only for a one-time move from another store. */
  readonly importDefinitions: (definitions: ReadonlyArray<AgentDefinition>) => Effect.Effect<void>
  /** Stores `overrides` as edits to the contributed definitions with the same ids; an id already stored is skipped. Only for a one-time move from another store. */
  readonly importOverrides: (overrides: ReadonlyArray<AgentDefinition>) => Effect.Effect<void>
}

/** Whether `value` has every {@link AgentDefinitionRegistry} member (a `MEMBERS` map, as in `mcp`). */
export const isAgentDefinitionRegistry: (value: unknown) => value is AgentDefinitionRegistry
/** The key `agent-definitions` provides its {@link AgentDefinitionRegistry} under. */
export const AgentDefinitionRegistryKey = ServiceKey.make('agentDefinitionRegistry', isAgentDefinitionRegistry)
```

Behaviour:

- A contributed definition with a stored override is listed with the override's fields, except `id` and `name`, and `edited: true`. An override stores every field, so a contributor's later change to its default does not reach a definition the user edited.
- An override whose id no plugin contributes is not listed.
- A stored user definition whose name a contribution takes later stays listed; the contribution's `register` fails with `AgentDefinitionNameTaken`.

Storage: `<dataDir>/data.db`, table `definitions (id TEXT PRIMARY KEY, override INTEGER NOT NULL CHECK (override IN (0, 1)), definition TEXT NOT NULL)`, `definition` the JSON of `AgentDefinition`.

### `plugins/mcp/registry.ts`

```ts
/**
 * Adds `servers` to the user's servers, in order, and returns the name each one is held under.
 * A server keeps its name when no user or contributed server holds that name, or the holder has an equal config; otherwise it
 * takes the first of `<name>-2`, `<name>-3`, … that is free or holds an equal config. Running it
 * again with the same input returns the same names and adds nothing. Only for a one-time move
 * from another store; it returns the names because the caller must rewrite its references.
 */
readonly importServers: (
  servers: ReadonlyArray<{ readonly name: string; readonly server: McpServer }>
) => Effect.Effect<ReadonlyArray<string>>
```

`makeRegistry(initial, writeUsers)` takes the persist effect for the whole user list; `importServers` persists before it changes the registry, as `replaceUser` does. Config equality is structural equality of the decoded `McpServer`.

### `plugins/mcp/picker.ts`

```ts
/** `value` is the chosen server names; a chosen name the registry lacks is listed as `<name> (missing)`. */
export interface McpServerPickerProps {
  readonly label: string
  readonly value: ReadonlyArray<string>
  readonly onChange: (value: ReadonlyArray<string>) => void
}
/** The MCP server picker `mcp` provides. Read it with `useProvided(McpServerPickerKey)`. */
export const McpServerPickerKey = ServiceKey.make(
  'mcpServerPicker',
  (value): value is ComponentType<McpServerPickerProps> => typeof value === 'function'
)
```

The picker reads `WatchServers` and groups servers by source ("Your servers", "Plugin › <name>"), as `SkillPicker` groups skills.

### `plugins/skills`

```ts
// registry.ts
export interface SkillSource {
  readonly id: string
  /** A local Claude Code plugin directory a session must load for this source's skills. */
  readonly pluginPath: Option.Option<string>
  readonly skills: (context: SkillContext) => Stream.Stream<ReadonlyArray<Skill>>
}

/** `missing`: the names no source lists. `pluginPaths`: the `pluginPath` of each source that lists a name. */
export const SkillResolution = Schema.Struct({
  missing: Schema.Array(Schema.String),
  pluginPaths: Schema.Array(Schema.String)
})
export type SkillResolution = typeof SkillResolution.Type

/**
 * Resolves `names` against the sources' current skills for `context`. `Option.none()` when no
 * source is registered, or the sources' first lists do not arrive within 2 s; the caller then
 * cannot tell a missing name from one not listed yet.
 */
readonly resolve: (
  names: ReadonlyArray<string>,
  context: SkillContext
) => Effect.Effect<Option.Option<SkillResolution>>

// directory.ts
export interface DirectorySourceOptions extends SkillDirectory {
  readonly pluginPath: Option.Option<string>
}
```

`directorySource(id, options: DirectorySourceOptions)` copies `pluginPath` onto the source. `SkillDirectory` itself is unchanged: `claude-code` also uses it to read plugin skill directories, where a plugin path has no meaning.

`meta/host.ts` passes `pluginPath: Option.some(metaPluginDirectory(path, directory))`, a new export of `meta-repo.ts`; `claude-code`'s sources pass `Option.none()` (Claude Code loads them through its own settings).

### `SessionToolOptions`

```ts
export const SessionToolOptions = Schema.Struct({
  permissions: PermissionRules,
  mcpServers: Schema.Record(Schema.String, Schema.Unknown),
  /** Skill names for `Options.skills`; empty leaves every skill enabled. */
  skills: Schema.Array(Schema.String)
})
```

`session-tool-options.ts` adds `skills: []` to `NO_TOOLS`, `'skills'` to the `Pick`, and returns `...(skills.length === 0 ? {} : { skills: [...skills] })`. `session.ts` logs the skill count. Every `SessionToolOptions` producer sets `skills`.

### Kernel: `HostPluginContext.pluginsSettled`

```ts
/**
 * Resolves once the host's startup has settled every eager plugin (loaded, waiting, failed or
 * restart-required), as `PluginRegistry.start` does; at once for a plugin loaded after that.
 * Use it to tell a contribution still being registered at startup from one that is absent.
 */
readonly pluginsSettled: Effect.Effect<void>
```

`src/shared/plugin/api.ts` adds the member; the host builds it from a `Deferred` that `HostPlugins.start` completes after `PluginRegistry.start` returns (`src/host/host-main.ts:272`), and `host-plugins.ts`'s context extension passes `Deferred.await`. The renderer context does not get it. Bump `PLUGIN_API_VERSION` and every manifest's `api` as the repo's compatibility rule requires (checked at implementation in `isApiCompatible`). Test fakes of `HostPluginContext` gain `pluginsSettled: Effect.void`. ADR-0072 gets an amendment note: "the kernel needs no new API" no longer holds; `pluginsSettled` was added for missing references (#222).

### `org`

```ts
// domain.ts
/** A job title's id: the id of the agent definition it is. */
export const JobTitleId = AgentDefinitionId
/** A job title's name: an agent definition name. */
export const JobTitleName = AgentDefinitionName
/** A job title (ADR-0064, ADR-0072): an agent definition plus what only the org knows about it. */
export const JobTitle = Schema.Struct({
  ...AgentDefinition.fields,
  builtIn: Schema.NullOr(BuiltInJobTitle),
  enabled: Schema.Boolean
})
/** A change to a job title's definition fields. */
export const JobTitleEdit = AgentDefinitionEdit

/** A name a definition holds that resolves to nothing. */
export const MissingReference = Schema.Struct({
  kind: Schema.Literals(['mcp-server', 'skill']),
  name: Schema.String
})

```

`Issue` gains `missing: Schema.Array(MissingReference)`, required at every construction site; its JSDoc states that it is non-empty only while `status` is `triage`. `work.ts`'s `OrgEvent` gains `IssueRefused = Schema.TaggedStruct('IssueRefused', { missing: Schema.Array(MissingReference) })`.

`org/session-tools.ts`:

```ts
/** The definition's names all resolved: the session's tools and the plugin directories it loads. */
export const SessionToolsReady = Schema.TaggedStruct('Ready', {
  tools: SessionToolOptions,
  pluginPaths: Schema.Array(Schema.String)
})
/** Names that resolve to nothing in a registry that is provided and settled. */
export const SessionToolsMissing = Schema.TaggedStruct('Missing', {
  missing: Schema.NonEmptyArray(MissingReference)
})
/** A registry the definition needs is not provided, or not settled yet; try again later. */
export const SessionToolsUnavailable = Schema.TaggedStruct('Unavailable', {})
/** What `SessionTools.forDefinition` found. Build each case with its `.make`. */
export const SessionToolsResult = Schema.Union([
  SessionToolsReady,
  SessionToolsMissing,
  SessionToolsUnavailable
])
export type SessionToolsResult = typeof SessionToolsResult.Type

/** Resolves agent definitions' names for sessions, against the registries `org` currently holds. */
export interface SessionTools {
  /**
   * Resolves `definition`'s names in `cwd`. An MCP server name resolves when the `mcp` registry
   * lists it; a skill name when a skill source lists it. `Unavailable` when the definition names
   * MCP servers and `mcp` is not held, names skills and `resolve` returns none, or a name of a
   * kind is missing before `ctx.pluginsSettled` has resolved.
   */
  readonly forDefinition: (definition: AgentDefinition, cwd: string) => Effect.Effect<SessionToolsResult>
  /** Holds `registry` until the calling scope closes. Call inside `whenProvided([McpServerRegistryKey], …)`. */
  readonly holdMcp: (registry: McpServerRegistry) => Effect.Effect<void, never, Scope.Scope>
  /** Holds `registry` until the calling scope closes. Call inside `whenProvided([SkillSourceRegistryKey], …)`. */
  readonly holdSkills: (registry: SkillSourceRegistry) => Effect.Effect<void, never, Scope.Scope>
  /** Emits after each hold, each release, and once when `ctx.pluginsSettled` resolves. */
  readonly changes: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>
}

/** Makes the {@link SessionTools} for `org`'s setup scope. */
export const makeSessionTools: (pluginsSettled: Effect.Effect<void>) => Effect.Effect<SessionTools, never, Scope.Scope>
```

Each hold is `Effect.acquireRelease` of `Ref.set(ref, Option.some(registry))`, released to `Option.none()`, as `holdAgentBackend` does, and publishes on `changes`. `makeSessionTools(ctx.pluginsSettled)` forks, in `org`'s setup scope, `pluginsSettled` followed by setting a `settled` flag and one publish on `changes`. Before that, a missing name is `Unavailable`, because an eager contributor (meta's skill source, a plugin's MCP server) may not have registered yet; this follows `deepseek-harness`, which re-audits a pending row only after `loader.await()` (`agent-preset-registry/src/index.ts:150-153`, `mount.ts:118-121`).

`makeOrg` holds the definitions ref the same way: `Org` gains `holdDefinitions(registry): Effect<void, never, Scope>`, which publishes on `watchJobTitleChanges` at hold and release and forwards the registry's `changes` while held.

Order in `org`'s `setup`: `makeOrg`, `makeSessionTools(ctx.pluginsSettled)`, `makeDispatcher({ …, sessionTools })` (the dispatcher runs a pass on each `sessionTools.changes` emission and each `watchJobTitleChanges` emission), then the three `whenProvided` holds next to `holdAgentBackend`, the built-in registration, the handover, and `runAssistant({ …, sessionTools })`.

## Behaviour

### Contributed built-ins

`built-in-job-titles.ts` exports `BUILT_IN_DEFINITIONS`: the seven built-ins and the Executive assistant, built from `BUILT_IN_JOB_TITLES` and `EXECUTIVE_ASSISTANT` with the values a fresh `org.db` gives them (`allow` = `ISSUE_TOOLS` for the seven, `ROUTING_TOOLS` for the EA; `deny` = seed `deny`; `skills []`, `mcpServers []`, `bypassOptIn false`, `model null`, `thinkingLevel 'medium'`). `ISSUE_TOOLS` moves from `migrations.ts` to `built-in-job-titles.ts`. `BUILT_IN_KIND_BY_ID` maps each fixed id to its kind. `org`'s host registers each inside `whenProvided([AgentDefinitionRegistryKey], …)`, catching `AgentDefinitionIdTaken` and `AgentDefinitionNameTaken` per definition with a warning.

### Org job titles

- `org`'s host calls `org.holdDefinitions(registry)` inside `whenProvided([AgentDefinitionRegistryKey], …)`.
- `Org.jobTitles` = the registry's `list` joined with `job_title_settings (job_title_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)`; no row means enabled; `builtIn` from `BUILT_IN_KIND_BY_ID`. Without the registry, the list is empty. Order: built-ins in `BUILT_IN_DEFINITIONS` order, then the rest by name.
- `watchJobTitleChanges` emits on each registry `changes` emission (while provided) and on each `setJobTitleEnabled`.
- A semaphore of 1 in `makeOrg` is held by `hire` and `deleteJobTitle`, so the hire count and the definition delete cannot interleave. It guards only deletes made through `org`; a definition unlisted another way (its contributor unloads, another plugin calls `delete`) leaves hires whose job title is not listed, and the dispatcher logs a warning once per such hire id (a set in a `Ref`, cleared when the job title is listed again) instead of skipping it silently.
- `copyJobTitle` → `create` with the source's fields and the new name. `editJobTitle` → `edit`. `deleteJobTitle` keeps `BuiltInJobTitleDeleted` and `JobTitleHasHires`, then `delete`, then deletes the settings row. `hire` refuses an id the list lacks with `JobTitleNotFound`.
- Error mapping, keeping the RPC error unions in `calls.ts`: `AgentDefinitionNameTaken` → `JobTitleNameTaken`; `AgentDefinitionNotFound` → `JobTitleNotFound`; `ContributedDefinitionRenamed` → `BuiltInJobTitleRenamed`; `ContributedDefinitionDeleted` → `BuiltInJobTitleDeleted`.

### Migration and handover

`org` migration `9_agent_definitions`, in the migrator's transaction with `PRAGMA defer_foreign_keys = ON` (as `8_executive_assistant` does):

1. Copy `(issue_id, assignee)`, `(objective_id, assignee)` and `(comment_id, author)` where not null into TEMP tables. With `foreign_keys = ON`, dropping the old `hired_agents` fires `ON DELETE SET NULL` in those tables immediately; `defer_foreign_keys` defers only the constraint check. (`tasks`, the other former child, was dropped by `7_issues`.)
2. Rebuild `hired_agents` without the `job_titles` foreign key (create new, copy, drop old, rename new), write the saved values back with `UPDATE` in the same transaction, and drop the TEMP tables.
3. Create `job_title_settings` and insert `(job_title_id, 0)` for every `job_titles` row whose `enabled` is 0.
4. `ALTER TABLE job_titles RENAME TO job_titles_handover`.
5. `ALTER TABLE issues ADD COLUMN missing TEXT NOT NULL DEFAULT '[]' CHECK (status = 'triage' OR missing = '[]')`. Every `work.ts` `UPDATE` that moves an issue out of `triage` sets `missing = '[]'` in the same statement; SQLite rejects it otherwise.

`handover.ts`, run by `org`'s host inside `whenProvided([AgentDefinitionRegistryKey, McpServerRegistryKey], …)` while `job_titles_handover` exists:

1. Read the rows in `rowid` order.
2. `importServers` with every inline server of every row, row by row, in key order; map each row's servers to the returned names.
3. Built-in rows: compare each with its `BUILT_IN_DEFINITIONS` entry field by field (`skills`, `permissions.allow`, `ask` and `deny` as sets; `jobDescription` trimmed); `importOverrides` with the rows that differ. Other rows: `importDefinitions`. Both with `mcpServers` set to the names from step 2. A built-in seeded by an older dia version whose seed text differs from today's is imported as an override, which keeps the text the user had.
4. `DROP TABLE job_titles_handover`.

A failure before step 4 leaves the table; the next start repeats the handover with the same result (both imports skip stored ids; `importServers` returns the same names). Exception: if the user edits an imported server between the failure and the next start, the rerun gives that row's server a new suffixed name. Each step logs its counts. Until the handover finishes, the user's copied job titles are not listed and their hires are not dispatched; with `mcp` disabled that lasts until `mcp` is enabled, and the handover logs that it waits.

Record the SQLite finding (step 1: dropping a parent table fires `ON DELETE SET NULL` in its children; `RENAME` rewrites child references) in `docs/reasoning/` and its index once the migration test confirms it.

### Sessions and missing references

- `dispatcher.contextsFor` returns `{ contexts, refused }`. It skips issues the live map already holds (read before resolving), so it resolves only issues that could start, and calls `sessionTools.forDefinition(jobTitle, directory)` for each, before `nextStarts` reserves a slot:
  - `Unavailable`: the issue is in neither list and is logged at debug. It takes no slot; the next `sessionTools.changes` emission runs a pass.
  - `Missing`: the issue goes in `refused` with its names.
  - `Ready`: `tools` and `pluginPaths` go in its `StartContext`; `startIssue` passes them to `openSession` and does not resolve again.
- `pass` calls `runs.markRefused(issueId, missing)` for each refused issue, then signals once if any changed. `IssueRuns` gains `markRefused: (issueId, missing) => Effect<boolean>`: an update `WHERE status = 'todo'` that sets `status = 'triage'` and `missing`, appends `IssueRefused`, publishes `changes`, and returns false (logged at info, no signal) when the issue is no longer `todo`.
- The assistant calls `sessionTools.forDefinition(definition, directory)` before taking its `SynchronizedRef`, and `open` uses the `tools` and `pluginPaths` of that `Ready` result. `startOver` resolves first and, on `Missing`, returns without resetting the session row. Results:
  - `Ready` while detached: attach and clear the list.
  - `Missing`: detach if attached, set the list, log a warning.
  - `Unavailable`: leave the attachment as it is and the list unchanged.
- The assistant re-checks on each emission of the definition registry's `changes`, `sessionTools.changes`, the held `mcp` registry's `changes`, and `skillSourceRegistry.skills({ cwd: Option.some(directory) })`.
- `Assistant` gains `missing: Effect<ReadonlyArray<MissingReference>>` and `watchMissing` (a change stream). `org`'s host passes them to `readWorkView` and merges `watchMissing` into `watchWork`; `WorkView` gains `assistantMissing`.
- Known risk: a lazy plugin's contribution is not covered by `pluginsSettled` (it settles eager plugins only); a definition naming it is refused if dispatched before that plugin loads. The proof run restarts the app with a `dia-meta:*` skill on a hired agent's job title.

### UI

- `job-title-editor.tsx`: the MCP servers field renders `McpServerPicker` through `useProvided(McpServerPickerKey)`; without it, a textarea with one name per line. `Draft.mcpServers` becomes the names.
- `objective-screen.tsx`: an issue in triage with `missing` shows "Cannot start: missing github (MCP server), dia-meta:plan (skill)".
- `dashboard.tsx`: when `assistantMissing` is non-empty, an `Alert` reads "Executive assistant cannot start: missing …".

### Glossary

`docs/glossary.md` adds "agent definition" (the setup a session runs with, held by the `agent-definitions` plugin) and "job title" (the org's name for the agent definition a hired agent is hired as).

## Tests

| Criterion | Test |
|---|---|
| 1, 3 | `plugins/org/handover.test.ts`: a file `org.db` migrated to `8` with an edited built-in, an unedited built-in, a copy and two `github` servers with different configs; start `org`, `agent-definitions`, `mcp`; the job titles equal the rows; `mcp` lists `github`, `github-2`; the second definition names `github-2`; only the edited built-in is stored as an override. Run the handover again over the same data: nothing changes |
| — | `plugins/org/migrations.test.ts`: `9_agent_definitions` keeps `issues.assignee`, `objectives.assignee`, `issue_comments.author` and `reports_to` of existing hires |
| 2 | `plugins/org/dispatcher.test.ts`: a hired agent's session opens with the resolved `mcpServers` configs, `skills` and `pluginPaths` |
| 4, 5 | `dispatcher.test.ts`: a missing server or skill opens no session; the issue is `triage` with `missing`; accepting it clears `missing`. With `mcp` not provided, the issue stays `todo`, and with `overallCap` 1 a later issue that needs nothing still starts. A name missing before `pluginsSettled` resolves and registered before it does starts the session and never refuses. A `todo` issue the live map holds stays `todo` when its server is deleted |
| 6 | `plugins/skills/make-registry.test.ts`: `resolve` returns the meta source's `pluginPath` for a `dia-meta:*` name and lists an unknown name in `missing` |
| 7 | `plugins/mcp/server-picker.test.tsx`; `plugins/org/org-page.test.tsx` saves server names through a stub picker |
| 8 | `plugins/agent-definitions/make-registry.test.ts`: editing a contributed definition keeps its name; a new registry over the same database lists the edit |
| 9 | `plugins/org/assistant.test.ts`: a missing name keeps the assistant detached and sets `missing` once `pluginsSettled` resolves; registering the server attaches it; deleting it while attached detaches it; `startOver` with a missing name keeps the session row |
| — | `plugins/mcp/make-registry.test.ts`: `importServers` naming and idempotence. `plugins/claude-code/session-tool-options.test.ts`: `skills` is passed only when non-empty |

## Refinement Record

### Round 1

| # | Finding | Tag | Outcome |
|---|---|---|---|
| 1 | Rebuilding `hired_agents` with `foreign_keys = ON` nulls issue assignees and comment authors | blocker | Applied: save and restore through TEMP tables; migration test added |
| 2 | A registry not yet provided would send every issue to triage | blocker | Applied: `Unavailable` result; retry on the registry fill's signal. Contributor timing recorded as a known risk |
| 3 | `Schema.partial…` and `isComponent` do not exist; derived types missing | blocker | Applied |
| 4 | Handover stored every built-in as an override; the fresh-db equality test pins migration seeds | major | Applied: only built-in rows that differ are imported; test replaced |
| 5 | `skills` belongs in `session-tool-options.ts`; producers missing | major | Applied |
| 6 | Meta's source comes from `directorySource`; plugin dir is `<repo>/plugin` | major | Applied |
| 7 | Delete check and registry delete not atomic; registry ref unspecified; `ContributedDefinitionDeleted` unmapped | major | Applied: semaphore, ref, mapping |
| 8 | Handover blocked on `mcp` for rows with no servers | major | Rejected: `mcp` is an eager default plugin; splitting the handover into two gated passes adds a second drop condition for a configuration where the user disabled `mcp`. The wait is logged and documented |
| 9 | Two import methods are shallow; drop the `override` column | major | Partly applied: `makeRegistry(initial, writeUsers)`, `MEMBERS`, documented command-returns-names exception. Rejected merging the import methods: deciding "override" from "currently contributed" depends on whether `org`'s built-in registration ran before the handover, and `whenProvided` does not order separate blocks; the stored flag also stops an override listing as a user definition while its contributor is unloaded |
| 10 | Skills registry has no `changes`; `assistantMissing` path unspecified; `startOver` skipped the check | major | Applied |
| 11 | `missing` invariant enforced in scattered writes | major | Applied: CHECK constraint (with a stated fallback), `IssueRefused` in `OrgEvent`, required at construction sites |
| 12 | `mcp` exports, test and fake impact | minor | Applied |
| 13 | ADR-0072 lists `assistant` as the EA contributor; reasoning entry | minor | Applied |
| 14 | JSDoc, error fields, `isAgentDefinitionRegistry`, undecodable rows | minor | Applied |
| 15 | Test table cited undefined criteria | minor | Applied: "Success criteria" section |

### Round 2

| # | Finding | Tag | Outcome |
|---|---|---|---|
| 1 | `Unavailable` after reservation holds a cap slot and starves other issues | major | Applied: resolve in `contextsFor` before `nextStarts`; test with `overallCap` 1 |
| 2 | A skills registry with no sources, or a late contributor, makes `Missing` at start, which sends issues to triage | major | Applied: `SkillResolution.sources`; zero sources is `Unavailable`; `Missing` within `SETTLE` (5 s, `Clock`) is `Unavailable` with one scheduled signal. Rejected the "second resolve one debounce later" rule: `SETTLE` covers the start-up case with one timestamp and no per-issue state |
| 3 | Registry refs never reset on withdrawal | major | Applied: `acquireRelease` fills, as `holdAgentBackend` |
| 4 | Semaphore scope; unlisted job titles skipped silently | major | Applied: semaphore on `hire` and `deleteJobTitle`; warning log. Rejected showing unavailable hires in the agent overview: a UI addition outside the confirmed scope |
| 5 | Built-in comparison brittle to order and older seed text | minor | Applied: set comparison; older seed text imported as an override, stated |
| 6 | Assistant `open` hard-codes tools; no detach on `Missing` | minor | Applied |
| 7 | "Free" ambiguous in `importServers`; edit between crash and rerun | minor | Applied |
| 8 | `SessionToolsResult` hand-declared with raw `_tag`; code-block comments | minor | Applied |
| 9 | CHECK on `ADD COLUMN` verified; SET NULL is immediate; TEMP tables; `tasks` | minor | Applied (`tasks` was dropped by `7_issues`, `migrations.ts:235`) |
| 10 | Override stores every field; contributor updates do not reach it | minor | Applied: stated as behaviour |

### Round 3

| # | Finding | Tag | Outcome |
|---|---|---|---|
| 1 | `contextsFor` would refuse a `todo` issue whose session is live; `markRefused` had no guard | blocker | Applied: skip live issues; `markRefused` updates only `WHERE status = 'todo'`; test added |
| 2 | A module-level `sessionToolsFor` cannot read host-local refs | blocker | Applied: `makeSessionTools` returns `SessionTools`, passed to the dispatcher and the assistant |
| 3 | `SETTLE` measured from the org's setup, timer scope unstated | major | Applied: `providedAt` per held registry; timer forked in the `whenProvided` scope |
| 4 | The assistant never re-checks after `SETTLE` ends; `Unavailable` while attached unstated | major | Applied: `sessionTools.changes` in its re-check streams; `Unavailable` leaves the attachment |
| 5 | `resolve` can wait forever on `zipLatestAll`; `sources` count leaks interpretation | major | Applied: `resolve` returns `Option<SkillResolution>` with a 2 s timeout; `sources` removed (supersedes round 2 #2's `SkillResolution.sources`) |
| 6 | Resolving under the `SynchronizedRef`; `startOver` resets before checking | major | Applied |
| 7 | Setup order and the definitions-ref emitter unstated | major | Applied: `Org.holdDefinitions`; order in `setup` stated |
| 8 | Warning on every pass per orphaned hire | minor | Applied: once per hire id |
| 9 | `contextsFor` both queries and commands; missing tests | minor | Applied: returns `{ contexts, refused }`, `pass` refuses; tests added |

### After the rounds

| Source | Change |
|---|---|
| `deepseek-harness` `agent-preset-registry/src/index.ts:150-153`, `mount.ts:118-121`, checked at the user's request | The 5 s `SETTLE` window is replaced by `HostPluginContext.pluginsSettled`, confirmed by the user on 2026-11-09. Supersedes round 2 #2 and round 3 #3, #4's timer details |
