# Creator mode (`dia-creator`)

Starts and tracks Creator threads: runs that build dia plugins and skills in their own worktree of the meta repo, show per turn what they loaded and committed with a revert, and merge their branch into the meta repo's branch when the user asks.

Scope: module (a new feature plugin) plus small seams in existing code. Brief: confirmed in chat on 2026-11-18 (alignment, impeccable shape, implement-task Understand). Worktree per thread: chosen by the user at the design gate on 2026-11-20.

## Success criteria

1. The new-thread page's target picker lists `Creator mode`. Sending from it starts a run whose `cwd` is a new worktree of the meta repo on a `dia/<slug>` branch, listed on Settings › Worktrees, and whose `labels` include `dia-creator`, and shows its tab.
2. The run's tab is a row in the sidebar's Meta group, with the status indicator and activity line of a thread row, and in no project group. The row's menu offers Show, Rename and Delete, not Archive. The breadcrumb shows the tab name only, as for the Assistant.
3. The Meta group header's `+` and Settings › Plugins › `Create a plugin…` each open a Creator draft (a new-thread page whose target is Creator mode).
4. Agent definitions list a built-in `Creator`. Editing its model changes the model of the next Creator run. Deleting or renaming it is refused. Org job titles do not include `Creator`.
5. A Creator run is offered `plugin_list` and `plugin_inspect`; a run in a project is offered neither. `plugin_list` returns each plugin's name, status and source folder; `plugin_inspect` returns one plugin's manifest fields and service keys.
6. A turn that commits to the thread's branch shows a footer naming the plugins it loaded and the commit(s), with `Revert`. A turn with no commit and no plugin load shows no footer.
7. `Revert` adds a revert commit to the thread's branch, reloads the plugins loaded from the thread's worktree whose folders the reverted commits touched, and the footer then reads `<sha> reverted in <sha>`. A conflict leaves the worktree unchanged and shows git's reason in error red.
8. While the thread's branch has commits the meta repo's branch lacks, the footer of the newest turn with commits shows `<n> commits not merged` with `Merge`. `Merge` merges the branch into the meta repo's current branch with a merge commit, points every plugin override inside the thread's worktree at the same folder in the meta repo, reloads those plugins, and the footer then reads `Merged in <sha>`. A conflict leaves the meta repo unchanged and shows git's reason in error red.
9. After dia restarts, a plugin overridden to a folder in an unmerged Creator thread's worktree is loaded again without the user opening the thread.

## Interface

### Kernel and shared seams (src/)

```ts
// src/host/plugins/host-plugin-context.ts — added member
export interface HostPluginContext extends SharedHostPluginContext {
  readonly pluginTools: (turnEnded: (runId: string) => Effect.Effect<void>) => ReadonlyArray<DiaTool>
  /** Reads the plugins the Host knows, changes where one loads from, and reloads one. */
  readonly plugins: PluginControl
}

/** What a plugin's host entry can read about, and do to, the plugins the Host knows. */
export interface PluginControl {
  /** Every plugin the Host knows, as Settings › Plugins lists them. */
  readonly list: Effect.Effect<ReadonlyArray<PluginInfo>>
  /**
   * `name`'s info with the manifest fields an author reads, read from its folder's `plugin.json`
   * (so a failed or unloaded plugin can be inspected). Fails with `PluginNotFound` for a name the
   * Host does not know and `PluginManifestUnreadable` when `plugin.json` cannot be read or decoded.
   */
  readonly inspect: (
    name: string
  ) => Effect.Effect<PluginDescription, PluginNotFound | PluginManifestUnreadable>
  /** Points `name` at source folder `directory` without loading it, as `plugin_override` does before its reload. */
  readonly setOverride: (name: string, directory: string) => Effect.Effect<PluginOverrideResult>
  /**
   * Reloads `name` in a kernel fiber the caller's interruption does not stop, and returns its
   * info after the reload. A failed reload keeps the previous version and reports it in `status`.
   */
  readonly reload: (name: string) => Effect.Effect<PluginInfo>
}

// src/shared/plugin/manifest.ts — added schemas
/** One plugin's info and the manifest fields an author reads; `load` has the default `lazy` filled in. */
export const PluginDescription = Schema.Struct({
  info: PluginInfo,
  inject: Schema.Array(Schema.String),          // [] when the manifest has none
  exports: Schema.Array(PluginExport),          // [] when none
  load: PluginLoadMode
})
export type PluginDescription = typeof PluginDescription.Type
export class PluginNotFound extends Schema.TaggedErrorClass<PluginNotFound>()('PluginNotFound', { name: Schema.String }) {}
export class PluginManifestUnreadable extends Schema.TaggedErrorClass<PluginManifestUnreadable>()('PluginManifestUnreadable', { name: Schema.String, message: Schema.String }) {}
```

`inspect` finds `name` in the registry's `list()` and reads its manifest with `PluginLoader.peek(name, info.root)` (`src/host/plugins/plugin-loader.ts:80`). `peek` re-declares the plugin's exports to the module registry when the plugin has never loaded; `inspect` documents this. `host-plugins.ts` builds `PluginControl` next to `pluginTools`, with `setOverride` the same call `PluginToolHost.setOverride` makes, and `reload` = `registry.load(name)` forked as `makePluginTools` does.

`PLUGIN_API_VERSION` goes to `0.0.47`, and `api` to `0.0.47` in every `plugins/*/plugin.json` and the `building-dia-plugins` reference. `PluginControl`, `PluginDescription`, `PluginNotFound` and `PluginManifestUnreadable` are re-exported from `src/host/plugin-api.ts`. `DiaRpcs` does not change, so `PROTOCOL_VERSION` stays.

```ts
// src/host/services/meta-repo-seam.ts — added member
export interface MetaRepo {
  /** Absolute path of the meta repo's working tree. */
  readonly directory: string
  // forNewSession, state, setRemote, push unchanged
}
```

`directory` is not added to `ALL_MEMBERS` (whose check expects effects and `setRemote`). `SessionMetaRepo` stays partial, so an older dia-meta still satisfies `MetaRepoKey`; dia-creator checks `typeof repo.directory === 'string'` and that `git.resolveCommit(directory, 'HEAD')` is `Some`, else fails `CreatorUnavailable('no-meta-repo')`.

```ts
// src/host/services/git-seam.ts — added members and schemas
/**
 * Makes one commit in `cwd` that reverts every commit in `commits` (newest first). On a conflict it
 * aborts, leaving the working tree as before, and returns `RevertConflict` with git's message.
 * Fails with `GitError` when git cannot run or the working tree has uncommitted changes.
 */
readonly revert: (
  cwd: string,
  commits: NonEmptyReadonlyArray<string>,
  options: { readonly message: string; readonly author: GitAuthor }
) => Effect.Effect<RevertResult, GitError>
/**
 * Merges `branch` into the branch checked out in `cwd` with a merge commit, even when a fast
 * forward is possible. On a conflict it aborts, leaving the working tree as before, and returns
 * `MergeConflict` with git's message. Fails with `GitError` when git cannot run or refuses to start
 * (for example, uncommitted changes the merge would overwrite).
 */
readonly merge: (
  cwd: string,
  branch: string,
  options: { readonly message: string; readonly author: GitAuthor }
) => Effect.Effect<MergeResult, GitError>

export const Reverted = Schema.TaggedStruct('Reverted', { commit: Schema.String })
export const RevertConflict = Schema.TaggedStruct('RevertConflict', { message: Schema.String })
export const RevertResult = Schema.Union([Reverted, RevertConflict])
export type RevertResult = typeof RevertResult.Type
export const Merged = Schema.TaggedStruct('Merged', { commit: Schema.String })
export const MergeConflict = Schema.TaggedStruct('MergeConflict', { message: Schema.String })
export const MergeResult = Schema.Union([Merged, MergeConflict])
export type MergeResult = typeof MergeResult.Type
```

dia-git implements `revert` with `git revert --no-commit <sha>` per commit, then `git commit -m <message>` with the author, and `git revert --abort` on a conflict. It implements `merge` with `git merge --no-ff -m <message> <branch>` with the author, and `git merge --abort` on a conflict.

### dia-runs (worktree runs opened in a tab)

`openInTab` publishes the run's working directory, not its source directory, and its worktree:

```ts
// src/host/services/runs-seam.ts — RunTabRequested gains a field
export const RunTabRequested = Schema.TaggedStruct('RunTabRequested', {
  runId: Schema.String,
  directory: Schema.String,                 // the worktree path when the run has a worktree
  worktree: Schema.NullOr(WorktreeInfo),    // added
  ...TabPlacement.fields,
  // model, backend, thinkingLevel, permissionMode, sessionId unchanged
})
```

`run-registry.ts` `openInTab` sets `directory` to `row.spec.worktree?.path ?? row.spec.sourceCwd` and `worktree` to `row.spec.worktree`. `pane-workspace.ts` `showRunInTab` adds `worktree` to the tab's `config` when it is not null, so the tab reattaches the worktree when it reopens. No caller passes a run with a worktree to `openInTab` today, so existing tabs do not change.

### dia-checkpoints (export only)

`plugin.json` gains `"exports": ["boundaries.ts"]`, and `plugins/dia-checkpoints/boundaries.ts` is added to `tsconfig.plugin-exports.json`'s `include`. dia-creator imports `@dia-plugin/dia-checkpoints/boundaries` and decides turn start and end with `boundaryOf`, so it does not define its own rule. Under ADR-0059 dia-creator reloads when dia-checkpoints reloads. `boundaries.ts` imports only `@dia/plugin` and `effect`, which the export rules allow.

### dia-threads (renderer slot)

```ts
// plugins/dia-threads/slots.ts — added
/**
 * A plugin whose owned tabs the Meta group lists as thread rows. `owner` is the plugin name that
 * `TabOwner.plugin` carries; `newThreadLabel` is the tooltip and accessible name of the header's
 * `+`, which calls `newThread`. dia-creator is the one source today.
 */
export interface MetaThreadSource {
  readonly id: string
  readonly order: number
  readonly owner: string
  readonly newThreadLabel: string
  readonly newThread: () => void
}
/** The Meta group's thread sources, declared by dia-threads. Add one with `addEntry`. */
export const MetaThreadSourcesSlot = ListSlot.make<MetaThreadSource>('threads.metaSources')
```

dia-threads' renderer calls `declareList(ctx, MetaThreadSourcesSlot)`. The Meta group header keeps `Meta` and `No open proposals`. Under it, dia-threads lists every unarchived tab whose `owner` is a registered source's `owner`, with `ThreadRow` (`projectName: null`), most urgent first as in project groups. `overview.ts` gains `buildMetaRows(workspace, summaries, owners)` for these rows; `buildOverview` keeps dropping owned tabs. `OverviewRow` gains `owned: Schema.Boolean`. `buildOverview` sets it to `false`, `buildMetaRows` sets it to `true`, and the dia-threads tests that build rows set it. `ThreadRow` hides only the Archive item when `row.owned`; Show, Rename, Delete and `ThreadRowMenuSlot` entries stay. The reason: Settings › Archived threads lists only unowned tabs (`archived-threads-settings.tsx:58`), so an archived owned thread could not be found again. Project groups never contain owned rows, so no caller passes a flag. The header shows one hover `+` icon button per source. Meta rows are `RowTarget`s placed first in `navigationOrder` and, like the Meta group, are hidden while a search or filter applies. In the collapsed rail they are status indicators after the Meta marker.

### dia-settings (renderer slot)

```ts
// plugins/dia-settings/slots.ts — added
/**
 * An action shown as an outline `sm` button above Settings › Plugins' list; `run` may close
 * Settings. dia-creator's `Create a plugin…` is the one action today.
 */
export interface PluginPageAction {
  readonly id: string
  readonly order: number
  readonly label: string
  readonly icon: ComponentType<{ readonly className?: string }>
  readonly run: () => void
}
/** Settings › Plugins' actions, declared by dia-settings. Add one with `addEntry`. */
export const PluginPageActionsSlot = ListSlot.make<PluginPageAction>('settings.pluginActions')
```

### dia-agent-definitions (moved code)

`runSettings`, `RunSettings` and `RunChoices` move from `plugins/dia-org/run-options.ts` to `plugins/dia-agent-definitions/run-settings.ts` (added to `exports`). `runSettings` takes `Pick<AgentDefinition, 'name' | 'selection' | 'thinkingLevel'>`, is named `Effect.fn('AgentDefinitions.runSettings')`, and logs `'No agent adapter is loaded'` with annotation `definition` when it returns none. `NO_AGENT_ADAPTER_MESSAGE` and `NoAgentAdapter` stay in dia-org. dia-org imports `runSettings` from there; the `runSettings` cases of `run-options.test.ts` move with it.

### dia-org (job title filter)

Org job titles exclude definitions whose `source` is a plugin other than `dia-org` (`RegisteredDefinition.source`), so `Creator` cannot be hired or offered to the Executive assistant's hire tools. User-created definitions and their copies keep `source` `User` and stay job titles. Confirmed by the user at the design gate.

### dia-meta

- Provides `directory` on `MetaRepo`.
- Ships a second skill, `writing-meta-skills`, from `plugins/dia-meta/writing-meta-skills/SKILL.md` into `plugin/skills/writing-meta-skills/SKILL.md`, written when missing and committed with the same rule as `building-dia-plugins`. The shipped-skill code takes a list of skill folders instead of one constant.

### dia-creator plugin

```json
{ "name": "dia-creator", "api": "0.0.47", "category": "feature",
  "host": "host.ts", "renderer": "renderer.ts", "load": "eager" }
```

No `inject` (services are read with `ctx.whenProvided`) and no `exports`.

### dia-creator host calls (`plugins/dia-creator/calls.ts`)

```ts
/** Starts a Creator thread with `text` and returns its run id. */
StartCreatorThread  payload { text: NonEmptyString }        success runId: string
                    error   CreatorUnavailable { reason: 'no-meta-repo' | 'no-model' | 'definition-missing' | 'worktree', message: string }
/** Creator run `runId`'s turn changes and merge state, re-sent whole on every change. */
FollowCreatorThread payload { runId: string }               stream CreatorThreadState
/** Reverts turn `turnId` of run `runId` and returns the turn with `revert` set. */
RevertTurn          payload { runId: string, turnId: string } success TurnChange
                    error   RevertFailed { reason: 'conflict' | 'nothing-to-revert' | 'git', message: string }
/** Merges run `runId`'s branch into the meta repo's branch and returns the merge commit. */
MergeCreatorThread  payload { runId: string }               success { sha: string }
                    error   MergeFailed { reason: 'conflict' | 'nothing-to-merge' | 'git', message: string }
```

```ts
/** Whether a plugin a turn loaded through a `plugin_*` tool was `Loaded` with no reload error at the turn's end. */
export const PluginLoad = Schema.Struct({ plugin: Schema.String, loaded: Schema.Boolean })
export type PluginLoad = typeof PluginLoad.Type

/** One Creator turn's commits and plugin loads; exists only for a turn with at least one of either. */
export const TurnChange = Schema.Struct({
  turnId: Schema.String,                       // the id of the turn's first user message
  messageIds: Schema.Array(Schema.String),
  ended: Schema.Boolean,
  commits: Schema.Array(Schema.Struct({ sha: Schema.String, subject: Schema.String })), // oldest first
  loads: Schema.Array(PluginLoad),
  revert: Schema.NullOr(Schema.Struct({ sha: Schema.String }))
})
export type TurnChange = typeof TurnChange.Type

/** A Creator thread's turns, how many branch commits the meta repo's branch lacks, and its last merge. */
export const CreatorThreadState = Schema.Struct({
  turns: Schema.Array(TurnChange),
  unmerged: Schema.Int,
  lastMerge: Schema.NullOr(Schema.Struct({ sha: Schema.String }))
})
export type CreatorThreadState = typeof CreatorThreadState.Type
```

The footer shows `Revert` only for an `ended` turn with commits and `revert: null`. `RevertTurn` for any other turn fails with `nothing-to-revert`. The footer of the newest turn with commits shows `<n> commits not merged` and `Merge` when `unmerged > 0`, and `Merged in <sha>` when `unmerged` is 0 and `lastMerge` is set. `MergeCreatorThread` with `unmerged` 0 fails with `nothing-to-merge`.

### dia-creator dia tools (Creator runs only)

| Tool | Input | Output text |
| --- | --- | --- |
| `plugin_list` | none | one line per plugin: `<name>  <status tag>  <default/override>  <root>`, plus the reload error when there is one |
| `plugin_inspect` | `{ name }` | `PluginDescription` as JSON; `isError` with "No plugin named <name>" or the manifest's read error |

Both registered with `when: (scope) => scope.labels.includes(CREATOR_LABEL)`.

## Key Data Structures

- `CREATOR_LABEL = 'dia-creator'` — the run label that scopes the tools and identifies Creator runs.
- `CREATOR_DEFINITION: AgentDefinition` — fixed id (a hard-coded UUID), name `Creator`, `skills: []`, `mcpServers: []`, `bypassOptIn: false`, `selection: null`, the default thinking level, `permissions.allow` = `mcp__dia__plugin_list`, `mcp__dia__plugin_inspect`, `mcp__dia__plugin_override`, `mcp__dia__plugin_reload`, `mcp__dia__plugin_clear_override` (file edits and shell commands follow the run's permission mode). Job description: what Creator builds (dia plugins in `plugins/<name>/`, skills in `plugin/skills/<name>/`), that it works in its current directory (its worktree) and points `plugin_override` at folders there, that it commits every finished change with a one-line message, and that it reads the `building-dia-plugins` or `writing-meta-skills` skill before starting. The definition's `skills` and `mcpServers` do not reach the run: `RunSpec` has neither field (same as the Executive assistant).
- Plugin database: `plugins/dia-creator/migrations.ts` exports `creatorMigrations`, whose migration 1 creates `creator_runs(run_id, last_sequence, worktree, last_merge_sha)` and `creator_turns(run_id, turn_id, message_ids, from_sha, to_sha, plugins, loads, revert_sha)`; `host.ts` opens `ctx.database(creatorMigrations)` once in setup, as dia-org does. `worktree` holds the run's `WorktreeInfo` as JSON. `to_sha` null means the turn has not ended; `plugins` holds the names a `plugin_*` call named during the turn.

## Internal Decomposition

- **`creator-definition.ts`** — owns `CREATOR_DEFINITION` and registers it with `AgentDefinitionRegistry` for the plugin's scope. An `AgentDefinitionIdTaken` or `AgentDefinitionNameTaken` failure (a user definition already named `Creator`) is logged with `Effect.logWarning`, and Creator mode then fails `start` with `definition-missing`.
- **`creator-threads.ts`** (`CreatorThreads`) — owns which runs are Creator runs and their worktrees.
  - `start(text)` checks the meta repo (`no-meta-repo`), reads the current `Creator` definition from `registry.list` (`definition-missing`), resolves `runSettings` (`no-model`), and calls `runs.open` with a new UUID `runId`, `sourceCwd` = meta directory, `worktree: { _tag: 'Create', label: 'Creator' }`, `resume: None`, `labels: [CREATOR_LABEL]`, `systemPromptAppend` = job description and `permissions`. A `WorktreeCreateError` fails `worktree` with its message. When the returned config has no `worktree` (dia-worktrees is not loaded and `open` fell back to the meta directory), it deletes the run with `runs.retire(runId, 'deleted')` and fails `worktree` with "The worktrees plugin is not loaded." It then inserts `creator_runs` with the config's `worktree`, opens the run in a tab owned by `dia-creator` (`ownsProject: true`, `projectDirectory` = meta directory, `select: false`, `name: 'Creator'`; the user renames it from the row menu), then `runs.send(runId, text, 'queue')`. Recording the run before sending means `TurnChanges` knows the run before its first turn starts.
  - On setup, after the services are provided and before `TurnChanges` catches up, it reattaches the worktree of each recorded run whose branch the meta repo's branch lacks commits from, with `gitOps.reattachWorktree(info, runId)`, and reloads every plugin whose `status` is `Failed` and whose override `root` lies inside one of those worktrees. A `WorktreeReattachError` is logged with `Effect.logWarning` and that run is skipped.
  - `merge(runId)` runs under the run's semaphore (shared with `revert`). With `unmerged` 0 it fails `nothing-to-merge`. Otherwise it reads the meta `HEAD`, calls `git.merge(metaDirectory, worktree.branch, { message: 'Merge <branch>', author })`, and stores `last_merge_sha`. Then, for each plugin whose `origin` is an override and whose `root` lies inside the worktree, it calls `plugins.setOverride(name, <meta directory>/<root relative to the worktree>)`. It reloads those plugins and every plugin rooted in the meta directory with a file in `git.changedFiles(<HEAD before>, <merge commit>)`, using the same order as `revert`: plugins other than `dia-creator` and `dia-runs` first, awaited, then the reply, then those two with `Effect.forkDetach`. `MergeConflict` maps to `MergeFailed('conflict')`, and `GitError` to `MergeFailed('git')`. A `setOverride` result of `Rejected` is logged with `Effect.logWarning` and the plugin keeps its worktree override.
- **`turn-changes.ts`** (`TurnChanges`) — owns what each Creator turn changed. Git calls for a run use its worktree path as `cwd`. On setup it opens `runEvents.subscribe` (scoped) first, then for each recorded run reads `runEvents.readTagged(runId, ['PaneUserMessagesSent', 'PaneAttentionChanged', 'ToolCallCompleted'])` (no replay limits), folds the events with `sequence > last_sequence` in order, and then drains the subscription, skipping events of unrecorded runs and events with `sequence <= last_sequence`. For each event it first reads the worktree `HEAD`, `git.log` and `plugins.list` outside any transaction. Then one `sql.withTransaction`, which holds only SQL, writes the `creator_turns` change and the run's new `last_sequence`, so a replayed event is never applied twice. If git fails, it logs `Effect.logWarning`, skips the event's effect, and still advances `last_sequence`. `start` inserts `creator_runs` with `last_sequence` = `runEvents.highestSequence` and adds the run to the in-memory set of recorded runs before it sends the text; the live loop checks that set. With `boundaryOf`:
  - A turn start whose `turnId` already has a row is ignored. Otherwise it creates the row, reading `from_sha` (worktree `HEAD`) only then. A turn start while a turn is open (a `steer`) first closes the open turn at the current `HEAD`.
  - A `ToolCallCompleted` whose `toolName` is `mcp__dia__plugin_override`, `…plugin_reload` or `…plugin_clear_override` adds `input.name` to the open turn's `plugins`.
  - A turn end with no open turn is ignored. Otherwise it records `to_sha`, the commits `from_sha..to_sha` (subjects from `git.log`), and for each name in `plugins`, `loaded` = its `plugins.list` status is `Loaded` with no `reloadError`. A parked end closes the turn; the resumed turn continues with no new turn start, so its later commits fall outside every range (Known limits).
  - The row is kept only when the turn has a commit or a load.
  - `unmerged` is the number of lines of `git.log(metaDirectory, ['--format=%H', 'HEAD..<branch>'])`, read after each turn end, revert and merge, and when a follower subscribes.

  `revert(runId, turnId)` runs under the run's semaphore. When `revert_sha` is stored, it returns the stored turn. Otherwise it runs `git.revert` in the worktree on the turn's commits (newest first, message `Revert "<subject>"` or `Revert <n> commits`) and stores `revert_sha`. It then finds every plugin whose `root` lies inside the worktree and contains a file `git.changedFiles(from_sha, to_sha)` lists. It reloads the plugins other than `dia-creator` and `dia-runs` and waits for them, then builds the returned `TurnChange`. Last, it starts any `dia-creator` and `dia-runs` reloads with `Effect.forkDetach` and does not wait: reloading either one closes this handler's scope, and the reply must reach the renderer first. After that reload, the footer reads the thread again through `FollowCreatorThread` and shows `reverted` from the stored `revert_sha`. `RevertConflict` maps to `RevertFailed('conflict')`, `GitError` to `RevertFailed('git')`.
- **`plugin-tools.ts`** — builds `plugin_list` and `plugin_inspect` over `ctx.plugins`.
- **`host.ts`** — opens the database, then wires the above with `ctx.whenProvided([RunsKey, RunEventsKey, GitKey, MetaRepoKey, WorktreesKey, ToolsKey, AgentDefinitionRegistryKey, AgentAdaptersKey])`, and serves the calls.
- **`renderer.ts`** — adds the `ThreadTargetsSlot` entry (`id: 'creator'`, label `Creator mode`, `Hammer` icon; `send` = `StartCreatorThread` then `OpenRunInTab`, mapping `CreatorUnavailable` to: `no-meta-repo` → "The meta repo is not available.", `no-model` → "No agent adapter is loaded.", `definition-missing` → "The Creator agent definition is missing.", `worktree` → its `message`), the `MetaThreadSourcesSlot` entry (`owner: 'dia-creator'`, `New Creator thread`, `newThread(PluginThreadTarget.make({plugin: 'dia-creator', id: 'creator'}))`), the `PluginPageActionsSlot` entry (`Create a plugin…`, same draft, closes Settings), and the `TurnFootersSlot` entry.
- **`turn-change-line.tsx`** — the footer: follows `FollowCreatorThread`, picks the `TurnChange` whose `messageIds` intersect the footer's, and renders the shape brief's states (loaded, did not reload, commits, `Revert`, reverting, reverted, conflict, git failure). On the newest turn with commits it adds the merge line (`<n> commits not merged` with `Merge`, merging, `Merged in <sha>`, conflict, git failure).

Every export carries JSDoc stating its use. `CreatorThreads.start`, `merge`, each reattach, each turn's open and close, and `revert` log with `Effect.logInfo`, and failures with `Effect.logWarning`.

## Design Rationale

**One worktree per thread, merged by the user** — ADR-0025 makes changes to a git repo on a branch in a new worktree and has the user approve the merge. A worktree per thread keeps two threads' commits on separate branches, so each turn's range and each revert hold only that thread's commits, and other runs see the thread's skills only after the merge. `Runs.open` already provisions and releases run worktrees through dia-worktrees, so the worktree is listed on Settings › Worktrees and a dirty one waits for the user's decision (ADR-0073).

**Merge moves overrides to the meta repo** — an override into a worktree points at a folder that dia-worktrees removes when the thread is deleted. After a merge the same code is in the meta repo, so the override is moved there and stays valid.

**Reattach on setup** — dia-worktrees removes a clean worktree when its run ends, including at quit (`plugins/dia-worktrees/git-ops.ts:97`). A plugin overridden into it would fail at the next start until the thread reopens. dia-creator reattaches unmerged threads' worktrees and reloads those plugins, so a plugin under test keeps loading across restarts.

**dia-threads draws the Meta rows** — the sidebar already owns turning tabs into rows. A source declares only which owner's tabs belong under Meta, so Creator rows behave like thread rows and dia-creator does not reimplement them (Information Hiding; Deep Modules).

**`PluginControl` on the host context** — the plugin registry is kernel state. One narrow member with list, inspect, setOverride and reload keeps the registry's internals (`use`, `inject`, load ordering) hidden while giving the tools, Revert and Merge what they need. `inspect` reads `plugin.json` from disk so a plugin that failed to load can still be inspected, which is when an author needs it.

**Turn boundaries from `boundaryOf`** — dia-checkpoints already defines which events start and end a turn; reusing it keeps one rule.

**Turn changes keyed by the turn's first message id** — footers receive only `paneId` and `messageIds`; keying by message id matches dia-cost's footer.

**`loaded` read from plugin status at turn end** — a `plugin_*` tool result is not an error for `Unloaded` or a deferred self-reload, so the registry's status at turn end is the only reliable outcome.

**`runSettings` moves to dia-agent-definitions** — it turns an agent definition into run options. Creator and the org both need it, and dia-creator must not depend on dia-org.

## Rejected Alternatives

- **Commit directly on the meta repo's branch** — chosen in alignment, then replaced at the design gate: two threads with overlapping turns attribute each other's commits to both turns and can revert each other's work, and it contradicts ADR-0025's worktree rule.
- **`Runs.start` with a `worktree` option** — `start` returns `Effect<string>` with no error channel; a worktree failure would need a new error type at every caller. `Runs.open` already takes a worktree and fails with `WorktreeCreateError`.
- **dia-creator creates its own worktrees with `git.addWorktree`** — they would not appear on Settings › Worktrees, and dia-creator would need its own release rule for deleted threads.
- **Merge in the Meta row's menu** — `ThreadRowMenuSlot` entries appear on every thread row. The footer is where the user already sees the commits.
- **Rows drawn by dia-creator in a `SidebarSectionsSlot` section** — duplicates thread-row behaviour and places Creator below Pages instead of under Meta.
- **Deriving the meta directory from `forNewSession().pluginPaths[0]`** — depends on dia-meta's folder layout (Information Hiding).
- **Host builds `plugin_list`/`plugin_inspect` in `makePluginTools`** — Revert and Merge would still need a reload path.
- **Slots and per-plugin dia tools in `plugin_inspect`** — slots live only in the renderer and dia-tools does not record a tool's plugin.
- **Reusing dia-checkpoints' snapshots for the turn range** — its refs snapshot the working tree per turn, not the commits the turn made on the branch.

## Known limits

- A plugin overridden into a thread's worktree runs in every agent's session before the merge; the worktree separates files, not the running app.
- Deleting an unmerged thread releases its worktree; an override into it then fails to load and shows on Settings › Plugins until the user clears it.
- Two threads that override the same plugin name share one override; the last one set wins.
- The Creator run reads skills from the meta repo, not its worktree, so a skill it writes takes effect for it and every other run only after Merge.
- Reverting a turn that was already merged changes the meta repo's branch only at the next Merge.
- `from_sha` is read after the user-message event is delivered; a commit made before that read is not in the turn's range. Commits made by the next turn before `to_sha` is read are attributed to the previous turn.
- Commits made after a parked turn resumes belong to no turn and show no footer.
- A turn whose start or end event is read during catch-up, after dia-creator was unloaded or dia restarted, takes `HEAD` at replay time rather than at the event. Its commits can then be missing from its range, and a turn left with none shows no footer.
- When the user has registered the meta repo directory as a project, the first Creator tab claims it (`ownsProject: true` sets `owner` on a project with none, `workspace.ts:248`), and it leaves the project groups.

## ADR

ADR-0088 "Creator mode threads change dia on a worktree branch of the meta repo": extends ADR-0025 (Creator threads are user-started meta agents that work on a branch in a worktree; the user merges from the thread), and amends ADR-0036 (as amended by ADR-0064): a Creator thread may load a plugin from its worktree before the merge, so plugin code from a Creator thread runs before review, until `propose_change` (#43) exists. Extends ADR-0073 (Creator threads' worktrees are run worktrees in the ledger, reattached on startup while unmerged) and ADR-0081 (a plugin may list its owned tabs in the Meta group through `MetaThreadSourcesSlot`).

## Refinement Record

### Round 1

**Applied**
- *Correctness* (blocker) — first turn could commit before the run was recorded; `start` now starts without text, records, opens, then sends.
- *Correctness* — no catch-up after reload/restart; `last_sequence` and `readAfter` replay added; unended turns carry `ended: false`.
- *Correctness* — turn end undefined; uses dia-checkpoints' `boundaryOf` (exported).
- *Correctness* — `loaded: !isError` wrong for `Unloaded`/deferred self-reload; now read from `plugins.list` at turn end.
- *Correctness* — `RevertTurn` not idempotent; per-run semaphore and stored `revert_sha` short-circuit.
- *Define Errors Out of Existence* — revert of a loads-only turn; `Revert` shown only for ended turns with commits, `RevertFailed` has a `reason`.
- *Correctness* — manifest not exposed by the registry; `inspect` uses `PluginLoader.peek` and fails with typed errors.
- *Correctness* — `runSettings` move not behaviour-neutral; own message, name and annotation; tests move.
- *Correctness* — `Creator` would become a hireable org job title; org filters plugin-contributed definitions (escalated).
- *Correctness* — archiving an owned tab hides it everywhere; Meta rows offer Rename and Delete only.
- *Correctness* — empty permissions prompt for every dia tool; allow list of the five `plugin_*` tools.
- *Correctness* (minor) — `directory` kept out of `ALL_MEMBERS`; meta repo checked with `resolveCommit`.
- *Correctness* (minor) — `from_sha` race and next-turn attribution added to Known limits.
- *Correctness* (minor) — meta directory registered as a user project now fails `meta-repo-registered`.
- *Correctness* (minor) — keyboard order and filter behaviour of Meta rows stated.
- *Project rules* (minor) — API version bump, `declareList`, `plugin.json` for dia-creator.
- *Project rules* (minor) — JSDoc and logging stated.
- *Project rules* (minor) — `send` error text mapping.
- *ADR* (minor) — amendment chain named.
- *Avoid Hasty Abstractions* (minor) — single-consumer slots name their one use in JSDoc.

**Rejected**
- none

**Escalated**
- *dia-org job title filter* — the fix changes dia-org's behaviour (which definitions become job titles), outside the confirmed scope. Applied as the default; confirmed by the user at the gate.

### Round 2

**Applied**
- *Correctness* (blocker) — replay then subscribe skipped events and `readAfter` has limits; subscribe first, `readTagged`, sequence de-duplication, one transaction per event.
- *Correctness* (blocker) — replayed turn start would re-read `HEAD`; existing row makes it a no-op; open-turn-on-start and end-without-open-turn rules; parked resume in Known limits.
- *Correctness* — reloading `dia-creator`/`dia-runs` mid-revert could lose `revert_sha`; store first, reload those two last.
- *Correctness* — `ThreadRow` always renders Archive; `OverviewRow.owned` hides it with no caller flag; `buildMetaRows` added.
- *Correctness* — `meta-repo-registered` check would fail every start after the first and cannot compute `directoryKey`. Applied by removing the guard instead of fixing it (a plugin cannot compute `directoryKey`); the claim behaviour is in Known limits.
- *Correctness* — `register` failures (a user definition named `Creator`) logged and surfaced as `definition-missing`.
- *Project rules* — `tsconfig.plugin-exports.json` include and the ADR-0059 reload coupling stated.
- *Correctness* (minor) — `peek` re-declares exports; documented.
- *Project rules* (minor) — `creatorMigrations` in `migrations.ts`.
- *Correctness* (minor) — tab name `Creator`.

**Rejected**
- none (finding 11 raised no change)

### Round 3

**Applied**
- *Correctness* (blocker) — the `RevertTurn` reply would be lost when it reloads `dia-creator` from its own handler. Fixed at the call site: the other plugins are reloaded and awaited, the reply is built, and the `dia-creator`/`dia-runs` reloads are forked last without waiting. `PluginControl.reload` stays the same for every plugin, so its interface has no special rule for the caller's own plugin (Strategic Programming).
- *Correctness* — git calls inside the SQL transaction would hold the plugin's one connection. Git and plugin reads now happen first and the transaction holds only SQL. A git failure is skipped and `last_sequence` still advances, chosen over retrying so that a persistent failure cannot block the run's later events.
- *Correctness* — replayed turn boundaries take today's `HEAD`; added to Known limits.
- *Correctness* (minor) — set `OverviewRow.owned` in both builders and the tests; only Archive is hidden.
- *Correctness* (minor) — initial `last_sequence` and the in-memory set of recorded runs stated.
- *Project rules* (minor) — criterion 2 now names the row menu.

**Rejected**
- none

### Gate change (user, 2026-11-20)

**Applied**
- *Worktree per thread* — Creator threads run in a worktree of the meta repo on their own branch instead of committing to the meta repo's branch. Added: `Git.merge`, `PluginControl.setOverride`, `RunTabRequested.worktree`, `MergeCreatorThread`, `CreatorThreadState`, the merge footer line, reattach on setup, criteria 8 and 9. The run opens through `Runs.open` because `Runs.start` takes no worktree. Removed the overlapping-threads known limit; added the worktree known limits. Not reviewed by a critique round; the rounds budget was spent before the change.
