# Sidebar lists open threads only; the start page completes commands and paths

Status: accepted

## Purpose

The new-thread page (ADR-0083) is now the place to pick a project and start a thread. The sidebar's Threads section therefore lists only projects that have an open thread. Project management and archived threads move to two Settings pages. The new-thread page completes `/` commands and `@` paths for the selected project, as a thread's composer does.

## Success criteria

1. With projects `dia` (1 open thread) and `skills` (0 open threads), the sidebar lists `dia` and not `skills`.
2. Archiving `dia`'s last open thread removes `dia` from the sidebar.
3. With no open thread in any project, Threads shows a dashed empty state whose **New thread** button opens the new-thread page.
4. No project header shows `git`; no `Archived (n)` row exists.
5. Settings > Projects lists `skills`; **Remove project** opens the existing removal dialog.
6. Settings > Archived threads lists an archived `dia` thread; clicking it closes Settings and shows the thread.
7. On the new-thread page with `dia` selected, `Loading commands…` shows above the composer while dia's commands load; once loaded, typing `/` lists them and choosing one completes it.
8. Switching the picker to `skills` replaces the list with `skills`' commands.
9. Typing `@src/` lists entries of the selected project's `src/`.

## Modules

### 1. `AgentBackend.slashCommands` (`plugins/dia-runs/backend.ts`)

```ts
readonly slashCommands: (
  cwd: string,
  additions: SessionAdditions
) => Effect.Effect<ReadonlyArray<SlashCommandInfo>>
```

- The `AgentBackend` JSDoc paragraph gains: "`slashCommands` lists the slash commands a session started in `cwd` with `additions` loaded offers, read without starting a turn; it is empty when the agent cannot report them."
- Required member: added to `backendMethods`. `unavailableBackend.slashCommands` logs `logWarning('Cannot read slash commands', { cwd, reason: ADAPTER_NOT_LOADED })` and returns `[]`.
- Never fails: the adapter logs a failure and returns `[]`, as `disabledPermissionModes` does.
- `SlashCommandInfo` (schema value and type) is exported from `src/host/plugin-api.ts`; `calls.ts`, `backend.ts` and `slash-commands.ts` import it from `@dia/plugin`, because a shipped plugin cannot value-import `src/`.
- Updated for the new member: `backend.test.ts` (its complete-backend literal, and a case that a backend without `slashCommands` is reported as a problem), `plugins/dia-org/host.test.ts`. (`plugins/dia-org/runs.fake.ts` types its backend as `Pick<AgentBackend, 'models' | 'disabledPermissionModes'>` and needs no change.)

### 2. Claude Code implementation (`plugins/dia-claude-code/slash-commands.ts`)

```ts
/** A `supportedCommands()` read that failed or did not answer within {@link SLASH_COMMANDS_PROBE_TIMEOUT}. */
export class SlashCommandsProbeFailed extends Data.TaggedError('SlashCommandsProbeFailed')<{
  readonly message: string
}> {}

/** How long a slash-command read waits for Claude Code to answer before it fails. */
export const SLASH_COMMANDS_PROBE_TIMEOUT = Duration.seconds(30)

/**
 * The slash commands `idle` reports, as the renderer's `/` menu reads them. Fails with
 * {@link SlashCommandsProbeFailed} when the read rejects or times out.
 */
export const readSlashCommands = (
  idle: Query
): Effect.Effect<ReadonlyArray<SlashCommandInfo>, SlashCommandsProbeFailed>

/** The {@link AgentBackend.slashCommands} of the Claude Code install `install` resolves. */
export const listSlashCommands =
  (install: ClaudeInstall): AgentBackend['slashCommands'] =>
  (cwd, additions) => ...
```

- `listSlashCommands` resolves the install path; with none, it logs and returns `[]`. Otherwise it runs `withIdleQuery(path, cwd, readSlashCommands, additions.pluginPaths)` and turns `SlashCommandsProbeFailed` into a warning log and `[]`.
- `readSlashCommands` calls `idle.supportedCommands()`, applies the timeout, and maps rows with the existing `toSlashCommandInfo` (`reducer.ts:37`).
- `session-additions.ts` splits `pluginOptions(pluginPaths): Pick<Options, 'plugins'>` (one local plugin per path; `{}` for an empty list) out of `sessionAdditionsOptions`, which calls it. `withIdleQuery` (`idle-query.ts`) gains a fourth parameter `pluginPaths: ReadonlyArray<string> = []` and spreads `pluginOptions(pluginPaths)`. Its JSDoc reads "(models, account, commands)". `strictMcpConfig: true` stays (it also skips plugin MCP servers, sdk.d.ts:2367-2371), so MCP prompt commands are absent until the thread's own warm-up replaces the list.
- `makeClaudeCodeBackend` sets `slashCommands: listSlashCommands(deps.install)`.
- Unverified: whether a plugin's hooks run in an idle query that only answers `supportedCommands()`.

### 3. `GetSlashCommands` call (`plugins/dia-runs/calls.ts`, `host.ts`)

```ts
/** The slash commands a new session in `cwd` would offer, with the meta repo's plugins loaded. */
export const GetSlashCommands = Rpc.make('GetSlashCommands', {
  payload: { cwd: Schema.String },
  success: Schema.Array(SlashCommandInfo)
})
```

- `host.ts` names the additions effect it already builds for `makeRunRegistry` (`sessionAdditions`) and serves `GetSlashCommands` as `logDebug({ cwd })`, then `sessionAdditions`, then `backend.slashCommands(cwd, additions)`.
- This is a `dia-runs` plugin call over `CallPlugin`, not a `DiaRpcs` change: `PROTOCOL_VERSION` stays.

### 4. Renderer access

- `DiaApi.adapter.getSlashCommands(cwd: string): Promise<ReadonlyArray<SlashCommandInfo>>` (`src/shared/ipc/contract.ts`, `src/preload/host-api.ts` via `runQuery('GetSlashCommands', { cwd })`). JSDoc: "The slash commands an agent started in `cwd` offers, with the meta repo's plugins loaded; empty when the adapter cannot report them. Resolves once the adapter's read ends."
- `useSlashCommands(cwd: string | null): { readonly commands: ReadonlyArray<SlashCommandInfo>; readonly loading: boolean }` lives in `plugins/dia-chat/hooks/use-slash-commands.ts`, beside `useProjectEntries`, and is not exported from `plugin-api.ts`. It is `useQuery({ queryKey: ['slashCommands', cwd], queryFn, enabled: cwd !== null, staleTime: (query) => (query.state.data?.length === 0 ? 0 : Duration.toMillis(SLASH_COMMANDS_STALE)), refetchOnWindowFocus: false })` with `SLASH_COMMANDS_STALE = Duration.minutes(5)`; a rejected call resolves to `[]`; `loading` is `cwd !== null && isPending`. JSDoc adds: "An empty answer is not kept fresh: the next mount reads again." The cache stops reopening the page, or switching back to a project, from starting another `claude` process within five minutes; a failed read is retried on the next mount; a window focus never starts one.

### 5. Shared composer completion (`plugins/dia-chat/composer-completion.tsx`)

The `/` and `@` menu logic in `pane.tsx` (caret, highlight and dismissed state for both menus, token detection, filtering, completion, the arrow/Escape/Enter/Tab handling, the combobox ARIA attributes and the two menu elements) moves into one hook that `pane.tsx` and `new-thread-page.tsx` share.

```ts
/** The textarea props {@link useComposerCompletion} sets: the combobox role and ARIA state, and caret tracking. */
export type ComposerTextareaProps = Pick<
  ComponentProps<typeof InputGroupTextarea>,
  'role' | 'aria-expanded' | 'aria-controls' | 'aria-autocomplete' | 'aria-activedescendant' | 'onSelect' | 'onChange'
>

/**
 * `/` command and `@` path completion for a composer textarea. `text` and `setText` are the
 * composer's value; `commands` the commands to offer; `cwd` the directory paths are listed from,
 * or `null` to offer no `@` menu; `listId` makes the menus' element ids unique on the page;
 * `onPath` receives a chosen path.
 */
export function useComposerCompletion(input: {
  readonly text: string
  readonly setText: (text: string) => void
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>
  readonly commands: ReadonlyArray<SlashCommandInfo>
  readonly cwd: string | null
  readonly listId: string
  readonly onPath: (attachment: PathAttachment) => void
}): {
  /** The open menu, to render directly above the input group. */
  readonly menu: ReactNode
  /** Spread onto the textarea; its `onChange` calls `setText`, then tracks the caret and reopens dismissed menus. */
  readonly textareaProps: ComposerTextareaProps
  /** Call first in the textarea's `onKeyDown`; `true` when it handled the key. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
}
```

- The hook takes over `pane.tsx`'s `changeText`, `placeCaret`, `selectCommand` and `selectPath` (`pane.tsx:880-913`); `selectPath`'s `attachments.attach(PathAttachment.make({ path: entryPath(cwd, entry), kind }))` becomes `onPath(PathAttachment.make(...))`.
- In `pane.tsx`, `text` is `useStore(form.store, (state) => state.values.text)` (`useStore` from `@tanstack/react-form`, which re-exports it), so the pane re-renders on every form value change including `formApi.reset()`; `pane.tsx:785`'s `form.state.values.text` read is removed with the rest of the menu code. `setText` is `(value) => form.setFieldValue('text', value)`; `form.Field` still owns the textarea's `value`. In `new-thread-page.tsx`, `text` is `draft.text` and `setText` is `(text) => update({ text })`.
- Key order is unchanged: attachment Backspace, then the hook (path menu before slash menu; Enter on a path menu with no entry is not handled), then Enter to send.
- `listId` is passed to `SlashCommandMenu` and `PathMenu` as their `paneId` prop. `pane.tsx` passes its `paneId`; `new-thread-page.tsx` passes its `draftId`.
- With `cwd: null`, the hook calls `useProjectEntries` with `active: false` and never opens the path menu.
- `pane.tsx` passes `chat.slashCommands` and keeps the `chat.warmingCommands` line.
- `new-thread-page.tsx` passes `useSlashCommands(project?.directory ?? null)`, `cwd: project?.directory ?? null` and `onPath: attachments.attach` (its existing `useComposerAttachments`; `pickTarget` already clears attachments on a target switch). It wraps the `Loading commands…` line (shown while `loading`), then `menu`, then the `InputGroup` in a `relative` div (the menus are `absolute bottom-full`), spreads `textareaProps` onto its textarea, and its `onKeyDown` returns when the hook's `onKeyDown` returns `true` before its own Enter-to-send. A plugin target (the Assistant) has no project, so it gets no `/` and no `@` menu.

### 6. Sidebar (`plugins/dia-threads`)

- `buildOverview` returns a group only when the project has at least one open thread (a tab that is not archived and has no `owner`), with or without filters. `mostUrgent`, `shown` and `total` are unchanged. `OverviewGroup.archived`, `OverviewFilters.showArchived`, `archivedKey`, `ArchivedTarget` and their navigation entries are removed; `navigationOrder` loses its `archivedOpen` parameter.
- `ProjectGroup` loses the `git` tag, the `No threads` row, the archived list, the `archivedOpen` and `onToggleArchived` props, and its JSDoc clause about the archived toggle. Its `+` action and context menu (New thread, Reveal in Explorer, Remove project) stay.
- `FilterPopover` loses the Show archived option; `active` becomes `filters.statuses.length > 0`; its JSDoc drops "Show archived agents".
- `ThreadsSidebar` loses `archivedOpen`, `toggleArchived`, `effectiveArchivedOpen`, the `ArchivedTarget` case of `navKey`, and the `archivedKey` import.
- `ThreadRow` loses its `archived` prop and its Unarchive item; its `unarchive` helper (toast on refusal) moves to `archived-threads-settings.tsx`.
- `ThreadsSidebar`: when `userProjects(workspace)` is non-empty, `groups` is empty and `narrowing` is false, it renders `NoOpenThreads`: `<Empty className="border">` with title `No threads`, description `Threads you start appear here.`, and an outline `xs` **New thread** button that calls `actions.newThread()`. It is hidden in icon mode. While `narrowing`, `NoMatches` stays.

### 7. Settings pages (`plugins/dia-threads/renderer.ts`)

`dia-threads` adds two `SettingsPagesSlot` entries and two `CommandsSlot` entries, following `dia-meta/renderer.ts`. `plugin.json` needs no change.

- **Projects** (`projects-settings.tsx`, page `order: 15`, `FolderIcon`; command `Settings › Projects`, `order: 115`, `group: 'Settings pages'`): every `userProjects(workspace)` entry in the user's order: name, directory (mono, muted, truncated), and a `…` menu with `Reveal in Explorer` and `Remove project`. The page keeps `removing: ProjectId | null` and renders `<RemoveProjectDialog key={projectId} entry={entry} onClose={() => setRemoving(null)} />`. With no projects: `Empty` with title `No projects` and an **Add project** button calling `actions.registerProject()`; a refusal shows `REGISTER_PROJECT_REFUSAL_TEXT` under the button, as `TargetPicker` does.
- Both pages read `useWorkspace()` and `userProjects` from `@dia/renderer-plugin`, and render nothing while `useWorkspace()` is `undefined`.
- **Archived threads** (`archived-threads-settings.tsx`, page `order: 16`, `ArchiveIcon`; command `Settings › Archived threads`, `order: 116`, `group: 'Settings pages'`): archived user tabs grouped by project, in project order, then creation order within the project. Clicking a row's name calls `closeSettings()` then `actions.selectTab(paneId)`. A `…` menu has `Unarchive` and `Delete`; Delete opens `RetireThreadDialog` with retirement `delete`. With none: `Empty` with title `No archived threads`.
- `open-settings.ts` exports `CLOSE_SETTINGS_EVENT = 'dia:close-settings'` and `closeSettings()`; `plugin-api.ts` exports both; `settings-dialog.tsx` adds a listener that calls `setOpen(false)`.
- Unverified: that `RemoveProjectDialog` and `RetireThreadDialog` (alert dialogs) render and take focus correctly over the Settings dialog. Verify in the app.

### 8. Docs

- ADR-0083: an amendment note under "Entry points": per-project New thread rows are gone; the project header's `+` and context menu remain.
- PRODUCT.md "Threads and agents": "the sidebar lists threads by project" becomes "the sidebar lists open threads by project; a project with no open thread is not listed".
- DESIGN.md: line 250 drops "Show archived agents"; line 257 (row menu) drops Unarchive and its error toast, which move to Settings > Archived threads; line 261 (`Archived`) becomes "Archived threads are listed in Settings > Archived threads; the sidebar lists only projects with an open thread"; the sidebar section adds the dashed `No threads` empty state with its outline `xs` New thread button; line 302 adds "`Loading commands…` shows above the composer while the selected project's commands load; typing `/` or `@` opens the command or path menu of the selected project"; line 348 adds Projects and Archived threads to the Settings page list, with their row layouts (Projects: name, mono muted directory, `…` menu; Archived threads: project caption, thread name, `…` menu).
- `PLUGIN_API_VERSION` becomes `0.0.43` in `src/shared/plugin/manifest.ts` and in every `plugin.json` that declares `0.0.42`: `@dia/plugin` gains `SlashCommandInfo`, `@dia/renderer-plugin` gains `closeSettings` and `CLOSE_SETTINGS_EVENT`, and `AgentBackend` gains a required member. `PROTOCOL_VERSION` stays: `DiaRpcs` is unchanged.
- `docs/designs/dia-runs.md`: the call list gains `GetSlashCommands`.
- Every export named in §1-§7 carries JSDoc stating inputs, outputs and when to call it.

## Logging

- `listSlashCommands`: `logDebug` on start with `cwd` and plugin count; `logInfo` with the count on success; `logWarning` with the error on failure, timeout or no install.
- `GetSlashCommands` handler: `logDebug` with `cwd`.
- `unavailableBackend.slashCommands`: `logWarning` as in §1.
- Settings pages: `Effect.runFork(Effect.logDebug(...))` on unarchive, delete, remove and show, with `paneId` or `projectId`.

## Tests

- `overview.test.ts`: a project with only archived threads, and one with none, yield no group; filters do not bring them back. Remove the `showArchived` and archived-list cases.
- `threads-sidebar.test.tsx`: delete the Archived toggle, arrow-key and Unarchive cases (`:190-288`, apart from the archive case at `:216`; `asks before deleting an agent` at `:289` stays); add that the empty state shows when no project has an open thread and its button calls `actions.newThread`. `thread-row.test.ts` needs no change.
- `slash-commands.test.ts`: `readSlashCommands` with a fake `Query`: rows map through `toSlashCommandInfo`; a rejection and a timeout (`TestClock`) fail with `SlashCommandsProbeFailed`. `listSlashCommands` with an install that resolves none returns `[]`.
- `backend.test.ts`: a backend without `slashCommands` is reported as a problem.
- `use-slash-commands.test.ts`: a second mount with the same `cwd` inside `staleTime` calls `getSlashCommands` once; an empty first answer is read again on the next mount; a window focus does not call it; `null` does not call it and gives `loading: false`; a rejection gives `[]` and `loading: false`.
- `composer-completion.test.tsx` (inside a `QueryClientProvider`): `/re` then Enter completes the highlighted command; Escape dismisses; `@` then Enter calls `onPath`; `cwd: null` never opens the path menu.
- `pane.test.tsx` (or the existing pane composer test): after a send resets the form while the `/` menu was open, the menu is closed.
- `new-thread-page.test.tsx`: renders inside a `QueryClientProvider`, mocks `./hooks/use-slash-commands`, stubs `window.dia.listProjectEntries`; a project target passes its `directory`, the Assistant target passes `null`; Enter with the `/` menu open completes the command and does not send.
- `archived-threads-settings.test.tsx`: clicking a row calls `closeSettings` and `selectTab`; Unarchive calls `unarchiveTab`; a refusal shows the `Could not unarchive <name>` toast; a rejected call shows the lost-connection toast; Delete opens `RetireThreadDialog` with `delete`.
- `projects-settings.test.tsx`: lists every user project; Remove project opens `RemoveProjectDialog`.
- Existing `pane.tsx` tests pass unchanged.

## Refinement Record

### Round 1

| # | Finding | Tag | Outcome |
| --- | --- | --- | --- |
| 1 | `SlashCommandInfo` cannot be value-imported from `src/` in a plugin | blocker | applied: exported from `src/host/plugin-api.ts` |
| 2 | `cwd: ''` does not disable `useProjectEntries` | blocker | applied: `cwd: string \| null` |
| 3 | The test seam for the probe does not exist | blocker | applied: `readSlashCommands(idle)` and `SlashCommandsProbeFailed` |
| 4 | `ThreadRow.archived` would be dead code | major | applied |
| 5 | Remove project in both the sidebar and Settings | major | rejected: the confirmed scope keeps the sidebar context menu for listed projects |
| 6 | DESIGN.md not updated | major | applied |
| 7 | Settings `order: 10` collides with General | major | applied: 15, 16 |
| 8 | `closeSettings` under-specified | major | applied |
| 9 | Hand-rolled hook, uncached process per page open | major | applied: `useQuery` with a 5-minute `staleTime` |
| 10 | `new-thread-page.test.tsx` mock breaks | major | applied |
| 11 | Required member breaks existing fakes | major | applied |
| 12 | `ComposerTextareaProps` undefined; wiring order in prose | major | applied |
| 13 | Missing JSDoc on exports | minor | applied |
| 14 | `slashCommands` signature leaks a session option bag | minor | applied: `(cwd, additions)` |
| 15 | Logging incomplete | minor | applied |
| 16 | `withIdleQuery` builds an unused `systemPrompt` | minor | applied |
| 17 | Wording: `narrowing`, unchanged counts, test removals | minor | applied |

### Round 2

| # | Finding | Tag | Outcome |
| --- | --- | --- | --- |
| 1 | `PLUGIN_API_VERSION` bump omitted (`manifest.ts:16-24`) | major | applied: `0.0.43` |
| 2 | A failed read is cached as `[]` for 5 minutes; window focus refetches | major | applied: empty answers are stale at once; `refetchOnWindowFocus: false` |
| 3 | `onTextChange` ordering contract left to the caller | minor | applied: the hook owns `onChange` |
| 4 | New-thread page menu anchoring and Enter precedence unspecified | minor | applied |
| 5 | Archived test inventory wrong; unarchive coverage lost | minor | applied |
| 6 | DESIGN.md lines 257 and 348 missed; git tag not in DESIGN.md | minor | applied |
| 7 | `useSlashCommands` need not be a plugin API export | minor | applied: lives in `dia-chat` |
| 8 | Criterion 7 said loading starts on `/` | minor | applied: loading starts on project selection |
| 9 | Sidebar removal list incomplete | minor | applied |
| 10 | Settings page loading, refusal and dialog state unspecified | minor | applied |
| 11 | "Open thread" must exclude plugin-owned tabs | minor | applied |

### Round 3

| # | Finding | Tag | Outcome |
| --- | --- | --- | --- |
| 1 | `form.state.values.text` is not reactive in `useForm` | major | applied: `useStore(form.store, …)`, verified re-exported by `@tanstack/react-form` (`dist/esm/index.d.ts:2`) |
| 2 | `new-thread-page.test.tsx` has no `QueryClientProvider` | major | applied |
| 3 | New-thread page `onPath` unstated | minor | applied: `attachments.attach` |
| 4 | Key order stated twice; loading line position unstated | minor | applied |
| 5 | Test deletion range overshoots into the delete case | minor | applied: `:190-288` |
| 6 | `plugins` spread duplicated from `sessionAdditionsOptions` | minor | applied: `pluginOptions` helper |
| 7 | Stale status header | minor | applied |

Rounds ended at the medium budget of 3; round 3's two majors are applied, not open. No finding is escalated.
