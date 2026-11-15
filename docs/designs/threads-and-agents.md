# Threads and agents

Status: refined (3 rounds). Scope: kernel workspace schema, `dia-runs` placement, `dia-agent-overview` → `dia-threads`, `dia-layout` slots, `dia-org` (Agents section, Assistant entry, assistant notices), shared notice folding.

## Vocabulary (settled with the user)

| Term | Meaning |
| --- | --- |
| thread | a run the user starts and drives (ad-hoc tab, meta run) |
| agent | an org hire; in the sidebar, one row per issue run of a hire |
| Assistant | the Executive assistant's one persistent run, a thread outside every project |
| routine | a run a `dia-schedules` schedule starts |
| run | code's umbrella for both: `RunSummary`, `RunSummaryStatus` (today `AgentSummary`, `AgentStatus`); `RunStatus` in runs-seam keeps its name and meaning |

## D1. Tab owner

`Tab` gains `owner: Schema.optional(Schema.String)`: the plugin that lists the tab in the sidebar instead of the thread list. `Project` gains the same optional `owner`: a project dia registered only to hold an owned tab (the assistant's `<dataDir>/assistant`). The thread list lists only tabs without an owner, and leaves out projects with an owner; no other project list in the renderer (command palette, inbox labels) lists an owned project. A user project whose only tabs are owned still shows, empty, so the user can start a thread in it. (Hiding "projects whose tabs are all owned" was rejected for that reason.)

`TabPlacement` (runs-seam) gains `name: Schema.optional(AgentName)` and `owner: Schema.optional(TabOwner)`, where `TabOwner = Schema.Struct({ plugin: Schema.String, ownsProject: Schema.Boolean })`: `plugin` lists the tab; `ownsProject` says the directory is the plugin's own (the assistant's), not a user project. `run-registry.ts` forwards both into `RunTabRequested`. `PaneWorkspace.showRunInTab`:
- new tab: writes `owner.plugin` as the tab's `owner`, uses `name` instead of a generated name when given;
- existing tab (today a no-op in `importTab`): when the placement has an `owner` and the tab has none, sets the tab's `owner` and `name`. This backfills tabs #282 opened before this change;
- when `owner.ownsProject` is true, the project at `projectDirectory` (probed or already registered) gets `owner = owner.plugin` if it has none. This backfills the `assistant` project today's `Show the Executive assistant` registered. An issue run's placement has `ownsProject: false`, so user projects never get an owner.

`Project.owner` and `Tab.owner` are optional, so stored workspaces from before decode unchanged.

The tab header breadcrumb shows only the tab name when the tab's project has an owner (`Assistant`), otherwise `project › name`. An owned tab is not renamed, archived or deleted from the thread list (it is not listed there).

`PROTOCOL_VERSION` bumps once, because `Tab` and `Project` cross `DiaRpcs`.

## D2. Sidebar sections slot

`dia-layout/slots.ts` declares, beside `PagesSlot`:

```ts
export interface SidebarSection {
  readonly id: string
  readonly order: number
  /** Draws the section; `iconMode` is true while the sidebar is collapsed to its rail. */
  readonly component: ComponentType<{ readonly iconMode: boolean }>
}
export const SidebarSectionsSlot = ListSlot.make<SidebarSection>('layout.sections')
```

The sidebar (`dia-threads`) renders: header, Meta, Pages, each `SidebarSectionsSlot` entry in order, then the project groups under a `Threads` caption. Search and status filters apply only to the project groups.

`dia-org` adds the `agents` section. It lists one row per `AgentRun` whose run has a summary in `useRunSummaries()` (pane id = run id; a run with no tab has no row), ordered by `statusRank` of that summary, then issue title. Row: status indicator and the issue title; second line `<hire name, or job title> · <project>`, replaced by the status reason while it needs input or failed. (An initials avatar was left out: the status indicator already fills the leading slot.) (Issues have no human key: `Issue` in `dia-issues/domain.ts` has only an id.) Click: `actions.selectTab(runId)`. The section renders nothing when it has no rows. In icon mode each row is a status indicator with a tooltip naming hire, issue, project and status.

Rows come from a new streamed org call `WatchAgentRuns` (payload `{}`), success `Schema.Array(AgentRun)`:

```ts
AgentRun = Schema.Struct({ runId, issueTitle, projectName, hireName: NullOr(String), jobTitle: String })
```

served from `issue_runs` for issues in a started status (`understanding` … `in_review`), joined with the issues snapshot and hires, re-emitted after each change of issues, hires, job titles or registered projects that changes the list. A run is stored in `issue_runs` in the same pass that starts its issue, so an issue change covers it.

The tab name `dia-org` passes for an issue run is `<hire name, or job title> · <issue title>`, with the issue title truncated so the whole fits `AGENT_NAME_MAX_LENGTH` (64). In each issue pass, `dia-org` calls `openInTab` once per process for every started issue's run, finding the directory through `projectDirectoryOf(issue)` (`select: false`, `owner: { plugin: 'dia-org', ownsProject: false }`), which backfills owners and recreates a tab the user removed.

## D3. Page entry that shows a tab

The kernel hosts chat only in tabs: selecting a tab starts its session and the content area shows the visible tab's transcript (`actions.ts` `selectTab`, `pane-workspace.ts` `selectTab`). A page component cannot host the assistant's chat, so the entry selects the assistant's tab.

`Page` (dia-layout) gains `tab?: Atom.Atom<string | null>`, an atom naming the tab the entry stands for, or null. (A `useTab` hook was rejected: calling a hook read from a prop trips the React Compiler lint rule.) `PagesGroup` renders each page through a keyed `PageEntry` component inside `PluginBoundary`; `PageEntry` reads `page.tab` with `useAtomValue` and the tab's summary with `useRunSummaries()`. A page without `tab` renders as today. While it names a tab: clicking the entry calls `actions.selectTab(paneId)`, the entry is active while that tab is visible, and the entry shows that tab's status indicator from `useRunSummaries()`. While it is null or absent: the entry opens `component`, as today.

`dia-org` adds `{ id: 'assistant', order: 10.5, label: 'Assistant', icon: SparklesIcon, tab, component: AssistantPage }`, where `tab` maps `assistantRunId` out of the org live atom. `AssistantPage` (shown only while there is no run) shows the disabled message `The Executive assistant job title is disabled, so it cannot take requests.` while the job title is disabled. Otherwise it calls `OpenAssistant`, which starts a run that waits for its first message (ADR-0082), then `OpenRunInTab`; the page closes once the workspace shows that tab, so the user sees the normal empty thread with its composer centred. When `OpenAssistant` fails the page shows `The Executive assistant could not be opened.` and `Try again`.

`dia-org`'s assistant service (`assistant.ts`) calls `runs.openInTab(runId, { projectDirectory: <dataDir>/assistant, select: false, owner: { plugin: 'dia-org', ownsProject: true }, name: 'Assistant' })` whenever the assistant's `runId` becomes non-null (first `ask` or `open`, and at startup for a stored run). The dashboard's `Show the Executive assistant` keeps calling `OpenRunInTab`: `actions.selectTab` fails while the tab is not yet in the renderer's workspace, and `OpenRunInTab` creates it first.

Clear and compact are the thread's existing ones: `/clear` in the composer resets the conversation (the run and its tab stay; `ConversationCleared` already clears the transcript), and the context card's `/compact`. The dashboard's `Start over` (`StartOverAssistant`, archives the run) stays; the entry then falls back to `AssistantPage`.

## D4. Assistant notices

`AssistantDeps.runs` gains `busy`, `requests` and `isLive`. Notices still collect in `pending` (in memory, not stored). `makeAssistant` follows `Stream.zipLatest(runs.busy, runs.requests)`; before both have emitted, the run is not idle. The run is idle when it is live (`isLive`, evaluated on each combined emission and each new notice), `runs.busy` does not contain it (no turn, no background task), and `runs.requests` holds no open request of it (a run waiting on a permission, question or plan prompt is not busy, `run-registry.ts:93`, but is not idle). Delivery:
- On each emission of `busy` or `requests` and each new notice, when the assistant run is idle with notices pending, `makeAssistant` takes all of `pending` and sends one message `runs.send(runId, NOTICE_MARKER + lines.join('\n'), 'queue')`.
- It never reopens a closed run to deliver notices. While there is no run, or the run is not live, notices wait; `ask` takes pending notices into its message as today.
- Because a notice is sent only while the run is idle, it starts a turn at once and is never held in the composer's queue, except when the user sends a message in the same instant; the queue chip then shows the raw text with the marker (accepted).
- `startOver` clears `pending` (unchanged). `/clear` does not: pending notices go into the cleared conversation, so the assistant still learns them.

`NOTICE_MARKER` (`'[dia notice]\n'`) is a constant in `src/shared/domain/pane-chat.ts`. Both builders of user messages in that file, the live fold (`appendSentMessages`) and the history builder (`userMessage`), turn a user message whose text starts with the marker into a `role: 'notice'` message with the marker removed and no `checkpointUuid`, so it is not a rewind target. The existing notice rendering draws it.

The Assistant tab's composer is the normal thread composer (queue/steer). `AskAssistant` stays for the dashboard's request box and `AssistantPage`.

## D5. Rename

- `plugins/dia-agent-overview` → `plugins/dia-threads`, plugin name `dia-threads`. `settings-store.ts` `pluginOverrides` migrates the key `dia-agent-overview` → `dia-threads` alongside its existing renames. `localStorage` keys `dia.agent-overview.*` → `dia.threads.*`, reading the old key once when the new one is absent.
- `src/shared/domain/agent-summary.ts` → `run-summary.ts`; `AgentSummary` → `RunSummary`, `AgentStatus` → `RunSummaryStatus`, `useAgentSummaries` → `useRunSummaries`; every export site including `src/host/plugin-api.ts` and `src/renderer/src/plugin-api.ts`.
- Thread copy: `New thread`, `New thread in <project>`, `Start thread`, `Search threads and projects`, `Delete thread <name>?`, `This thread is archived.`, `No threads match these filters.`, archive dialog copy. Org copy keeps `agent`.
- Out of scope (persisted or DB names): `agent-event`, `agent-event-store`, `UnreadableAgent`, `AgentName`.

## D6. Docs

New ADR `NNNN-threads-and-agents.md` (vocabulary, tab owner, sections slot, page tab entry, notices) and index; glossary rows; PRODUCT.md Operating Context; DESIGN.md (Agent Overview → Thread list, Agents section, Assistant entry); `docs/designs/dia-org.md` D12 superseded; `docs/designs/agent-overview.md` → `threads.md`; reasoning entry for `importTab` skipping existing tabs.

## Refinement Record

Round 1 (sonnet):
1. blocker D4 not-live / dropped notices — applied.
2. blocker existing tabs never get owner — applied (showRunInTab updates existing tab; org re-opens at startup).
3. blocker `RunStatus` name clash — applied (`RunSummaryStatus`).
4. major drop `Project.owner`, hide all-owned projects — rejected: hides a user project that has agents but no threads, leaving no `+ New thread`.
5. major assistant tab opened by two paths — applied (org host opens unselected; page selects).
6. major `useTab` two-shape Page — applied in part: kept, with the reason (chat is hosted only by tabs) stated; status on entry added.
7. major `PROTOCOL_VERSION` — applied.
8. major notice folding location — applied (both builders in `pane-chat.ts`; history goes through `userMessage`).
9. major plugin rename scope — applied (`pluginOverrides`, host plugin-api).
10–14 minor — applied (name truncation, slot in dia-layout, raw hire fields, hide row without summary, reasoning entry).
Round 2 (sonnet):
1. blocker issue key does not exist — applied (issue title).
2. major leaving busy ≠ idle (waiting prompts) — applied (busy + requests).
3. major owner not set on a registered project — applied with change: `TabOwner.ownsProject`, so issue runs never mark a user project.
4. minor `/clear` and pending — applied (stated as intended).

Round 3 (sonnet):
1. major hooks in `pages.map` — applied (`PageEntry`).
2. minor queued marker leak — accepted and stated (only in a same-instant race).
3. minor two-stream idle — applied (`zipLatest`).
4. minor drop `issueId` — applied; the claim that `Issue.paneId` is the run id — rejected: `issue-runs.ts` takes the run id from `queue.enqueue` and stores it in `issue_runs`; `paneId` is not used there.

Own change: Clear uses the existing `/clear` (found in `agent-event.ts:70`), so no Clear button or header slot.
