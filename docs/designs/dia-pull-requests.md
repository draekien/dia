# `dia-pull-requests` plugin

An agent links the GitHub pull requests it opens to its run with the dia tool `link_pull_request`. The plugin stores the links per run, reads each pull request with the `gh` CLI, shows them in a `Pull requests` session rail card, and shows one pull request's details in a `Pull request` right panel. Shaped with the user on 2026-11-17 (`/impeccable shape`, `/implement-task`).

## Scope

In scope:

- The dia tool `link_pull_request({ url })`, offered to every run (`isRunScope`).
- Links stored per run in the plugin's own database (ADR-0042), so they survive a restart.
- Pull request details read with `gh pr view <url> --json …` in the Host. dia stores no GitHub token.
- Polling every 60 seconds while a renderer follows the run, for each pull request that is open, a draft, not yet read, or whose last read failed.
- A `Pull requests` rail card and a `Pull request` right panel.
- One kernel export, `openRightPanel`, so a plugin can open a tab's right panel on its own panel. `PLUGIN_API_VERSION` goes from 0.0.43 to 0.0.44.
- A new `dia-markdown` plugin owns dia's Markdown renderer (moved from `plugins/dia-chat/markdown.tsx`) and provides it under `MarkdownKey`. `dia-chat` and this plugin read it with `useProvided(MarkdownKey)` and show plain text while it is not provided.

Out of scope: creating, merging or reviewing pull requests from dia; detecting pull requests from `gh pr create` output; badges, OS notifications or decision-queue entries for pull request events; GitHub Enterprise hosts; inline review-thread comments; removing links when a run is deleted.

## Success criteria

| # | Criterion | Observed by |
|---|---|---|
| 1 | An agent calling `mcp__dia__link_pull_request` with a PR URL adds a row for that PR to its tab's `Pull requests` card | app; `pull-requests.test.ts`, `tool.test.ts` |
| 2 | A URL that is not a github.com pull request URL returns a tool error and links nothing | `pull-request-url.test.ts`, `tool.test.ts` |
| 3 | Linking the same URL twice shows one row | `pull-requests.test.ts` |
| 4 | Links survive a dia restart | `store.test.ts`; app |
| 5 | The card row shows the number, the title, and a muted state and checks line from `gh pr view` | `gh.test.ts` (mapping); app |
| 6 | Clicking a row opens the right panel on `Pull request` for that pull request | `pull-requests-card.test.tsx`; app |
| 7 | Ctrl+click (⌘+click on macOS) or middle-click on a row opens the pull request in the default browser, and the panel does not open | app |
| 8 | The panel shows the summary, checks, reviews and comments, and the rendered description | app |
| 9 | `Unlink` removes the row from the card | `pull-requests.test.ts`; app |
| 10 | With `gh` missing or failing, the row shows the error line and nothing crashes | `gh.test.ts`, `pull-requests.test.ts` |
| 11 | No poll-tick read runs for a merged pull request, and no poll-tick read runs after the last follower of the run ends (a first read from `link` is not a poll tick) | `pull-requests.test.ts` with `TestClock` |
| 12 | A tab with no links shows `No pull requests` | app |
| 13 | Every plugin still loads after the API version bump | `pnpm test` (manifest tests); app |

## Change list

```
plugins/dia-pull-requests/
  plugin.json            { "name": "dia-pull-requests", "api": "0.0.44", "category": "feature",
                           "host": "host.ts", "renderer": "renderer.ts", "load": "eager" }
  pull-request-url.ts    PullRequestUrl schema and PullRequestRef
  calls.ts               the host calls and the schemas they carry
  gh.ts                  GitHubCli: reads one pull request with `gh pr view`
  store.ts               migrations and the LinkStore over the plugin database
  pull-requests.ts       PullRequests: each run's links and their latest reads, with polling
  tool.ts                linkPullRequestTool
  host.ts                wiring: database, served calls, tool registration
  atoms.ts               renderer atoms over the host calls
  pull-requests-card.tsx the rail card body
  pull-request-panel.tsx the right panel body
  renderer.ts            adds the card and the panel
src/renderer/src/lib/right-panel.ts     + openRightPanel
src/renderer/src/plugin-api.ts          exports openRightPanel
src/shared/plugin/manifest.ts           PLUGIN_API_VERSION 0.0.43 → 0.0.44
plugins/*/plugin.json (all 28)          "api": "0.0.43" → "0.0.44"
plugins/dia-markdown/
  plugin.json            { "name": "dia-markdown", "api": "0.0.44", "category": "feature",
                           "renderer": "renderer.ts", "load": "eager", "exports": ["markdown.ts"] }
  markdown.ts            MarkdownProps, MarkdownKey (exported; type-only React import)
  markdown-view.tsx      the renderer, moved from plugins/dia-chat/markdown.tsx unchanged
  markdown-view.test.tsx moved from plugins/dia-chat/markdown.test.tsx
  renderer.ts            ctx.provide(MarkdownKey, Markdown)
plugins/dia-chat/pane.tsx, plan-review-card.tsx   read useProvided(MarkdownKey); plain text when undefined
tsconfig.plugin-exports.json            include + plugins/dia-markdown/markdown.ts
DESIGN.md                               Session rail "Cards from dia" + Pull requests;
                                        Right panel "Panels from dia" + Pull request
docs/designs/dia-pull-requests.md       this spec
```

### `dia-markdown`

A plugin export may import only `effect`, `@dia/plugin`, `@dia-plugin/*` and relative `.ts` files (`docs/designs/plugin-module-exports.md`, criterion 6), so a React component cannot be exported as a module. The user chose to make Markdown rendering a plugin that provides the component as a service, as `dia-mcp` provides `McpServersEditorKey` (`plugins/dia-mcp/editor.ts`).

```ts
/** Props of dia's Markdown block: the raw `content`, and `className` appended to the typeset wrapper. */
export interface MarkdownProps { readonly content: string; readonly className?: string }

/** dia's Markdown renderer, provided by `dia-markdown`. Read it with `useProvided(MarkdownKey)`; `undefined` while not provided. */
export const MarkdownKey = ServiceKey.make(
  'markdown',
  (value): value is ComponentType<MarkdownProps> => typeof value === 'function'
)
```

While `MarkdownKey` is not provided (`dia-markdown` unloaded, reloading or failed), each reader renders `content` as plain text with its line breaks kept (`whitespace-pre-wrap`).

## Modules

### `pull-request-url.ts`

```ts
/**
 * A github.com pull request URL, decoded from a string into the canonical form
 * `https://github.com/<owner>/<repo>/pull/<n>`. Decoding accepts `http:`, `www.github.com`, and a
 * trailing path, query or fragment (`/files`, `#issuecomment-1`); any other string fails.
 * Encoding returns the canonical string.
 */
export const PullRequestUrl = Schema.String.pipe(
  Schema.decodeTo(Schema.String.pipe(Schema.brand('PullRequestUrl')), /* parse + rebuild, or fail */)
)
export type PullRequestUrl = typeof PullRequestUrl.Type

/** The owner, repository and number a {@link PullRequestUrl} names. */
export const PullRequestRef = Schema.Struct({ owner: Schema.String, repo: Schema.String, number: Schema.Int })
export type PullRequestRef = typeof PullRequestRef.Type

/** The {@link PullRequestRef} of `url`. */
export const pullRequestRef: (url: PullRequestUrl) => PullRequestRef

/** `owner/repo#n`, the label the tool result and the card use. */
export const pullRequestLabel: (url: PullRequestUrl) => string
```

`pull-request-url.ts` imports nothing platform-specific: `calls.ts` imports it, and the renderer imports `calls.ts`. Only a `PullRequestUrl` reaches the store, `gh` and the calls, so no later step checks a URL again. The brand also limits every `href` the card and panel open to github.com.

### `calls.ts`

Every tagged struct is a named export with a JSDoc and a `typeof X.Type` alias, so code builds values with `.make`.

```ts
/** A check on the pull request's head commit. `url` links to its details when GitHub has one. */
export const PullRequestCheck = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(['pending', 'passed', 'failed', 'skipped']),
  url: Schema.optionalKey(Schema.String)
})

/** A submitted review. `at` is epoch milliseconds. */
export const PullRequestReview = Schema.TaggedStruct('Review', {
  author: Schema.String,                                  // login
  state: Schema.Literals(['approved', 'changes_requested', 'commented', 'dismissed']),
  body: Schema.String,
  at: Schema.Number
})

/** A comment on the pull request's conversation. `at` is epoch milliseconds. */
export const PullRequestComment = Schema.TaggedStruct('Comment', {
  author: Schema.String,
  body: Schema.String,
  at: Schema.Number
})

/** A review or a comment. */
export const PullRequestActivity = Schema.Union([PullRequestReview, PullRequestComment])

/** What dia shows about one pull request. */
export const PullRequestDetails = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.Literals(['open', 'draft', 'merged', 'closed']),
  author: Schema.String,
  baseRef: Schema.String,
  headRef: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
  body: Schema.String,
  reviewDecision: Schema.optionalKey(Schema.Literals(['approved', 'changes_requested', 'review_required'])),
  checks: Schema.Array(PullRequestCheck),
  activity: Schema.Array(PullRequestActivity)          // ascending by `at`
})

/** The first read has not finished. */
export const PullRequestReading = Schema.TaggedStruct('Reading', {})
/** The last read succeeded at `at` (epoch milliseconds). */
export const PullRequestRead = Schema.TaggedStruct('Read', { details: PullRequestDetails, at: Schema.Number })
/** The last read failed; `message` is one line for the user. */
export const PullRequestReadFailed = Schema.TaggedStruct('ReadFailed', { message: Schema.String })
/** What dia last learned about a linked pull request. */
export const PullRequestReadState = Schema.Union([PullRequestReading, PullRequestRead, PullRequestReadFailed])

/** One linked pull request and what dia last learned about it. */
export const LinkedPullRequest = Schema.Struct({ url: PullRequestUrl, read: PullRequestReadState })

/** The run's linked pull requests, oldest link first, now and after every change. */
export const FollowRunPullRequests = Rpc.make('FollowRunPullRequests', {
  payload: { runId: Schema.String },
  success: Schema.Array(LinkedPullRequest),
  stream: true
})

/** Removes the link; the pull request on GitHub is not changed. Unlinking an unlinked URL succeeds. */
export const UnlinkPullRequest = Rpc.make('UnlinkPullRequest', {
  payload: { runId: Schema.String, url: PullRequestUrl }
})

/** Reads the linked pull request again, whatever its state, and returns when the read ends. */
export const RefreshPullRequest = Rpc.make('RefreshPullRequest', {
  payload: { runId: Schema.String, url: PullRequestUrl }
})
```

A `ReadFailed` keeps no earlier details: the row shows the failure, and the next successful read replaces it.

### `gh.ts`

```ts
/** `gh` could not read the pull request. `message` is one line for the user. */
export class GhFailed extends Schema.TaggedError<GhFailed>()('GhFailed', { message: Schema.String }) {}

/** Reads pull requests from GitHub. */
export interface GitHubCli {
  readonly view: (url: PullRequestUrl) => Effect<PullRequestDetails, GhFailed>
}

/**
 * A {@link GitHubCli} that runs `gh pr view <url> --json <fields>` through the platform
 * `ChildProcessSpawner`, with `GH_PROMPT_DISABLED=1`. It works from any working directory. A
 * process still running after {@link GH_TIMEOUT} is killed and the read fails.
 */
export const makeGitHubCli: Effect<GitHubCli, never, ChildProcessSpawner>
```

```ts
/** How long one `gh` process may run. */
export const GH_TIMEOUT = Duration.seconds(30)
```

Timeout mechanism: each read runs the spawn, the stdout and stderr reads and the exit code inside `Effect.scoped`, wrapped in `Effect.timeoutOrElse({ duration: GH_TIMEOUT, orElse: () => Effect.fail(GhFailed.make({ message: 'GitHub CLI timed out' })) })`. Closing the scope kills the process; the command sets `forceKillAfter: Duration.seconds(5)` (`effect/process/ChildProcess.ts:270`), so a `gh` that ignores the first signal is still killed and the read releases its gate.

Fields read (gh 2.100.0, `gh pr view --help`): `number,title,state,isDraft,author,baseRefName,headRefName,additions,deletions,body,reviewDecision,statusCheckRollup,reviews,comments`. `--json reviews` and `--json comments` return every item (`pkg/cmd/pr/shared/finder.go`, `preloadPrReviews`, `preloadPrComments`).

Mapping, inside `gh.ts` only:

| gh JSON | dia |
|---|---|
| `state: OPEN` and `isDraft: true` | `draft` |
| `state: OPEN` | `open` |
| `state: MERGED` / `CLOSED` | `merged` / `closed` |
| `author.login` | `author` |
| `reviewDecision` `APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED` | lower case; `""` or missing → key absent |
| `statusCheckRollup: null` | `checks: []` |
| CheckRun `status` not `COMPLETED` | `pending` |
| CheckRun `conclusion` `SUCCESS` / `NEUTRAL` | `passed` |
| CheckRun `conclusion` `SKIPPED` / `STALE` | `skipped` |
| CheckRun any other `conclusion` | `failed` |
| CheckRun `name`, `detailsUrl` | `name`, `url` |
| StatusContext `state` `SUCCESS` / `PENDING`, `EXPECTED` / `ERROR`, `FAILURE` | `passed` / `pending` / `failed` |
| StatusContext `context`, `targetUrl` | `name`, `url` |
| review with `state: PENDING` or `submittedAt: null` | left out |
| review `submittedAt`, comment `createdAt` (RFC 3339) | `at` (epoch ms); activity sorted ascending |

Failures:

| Case | `message` |
|---|---|
| the process cannot start | `GitHub CLI (gh) is not installed` |
| exit 4 | `GitHub CLI is not logged in. Run gh auth login.` |
| any other non-zero exit | the first line of stderr |
| still running after `GH_TIMEOUT` | `GitHub CLI timed out` |
| stdout does not decode | `Could not read the GitHub CLI output` (the decode error is logged) |

The state values `OPEN`/`CLOSED`/`MERGED`, the review states and the `reviewDecision` values come from GitHub's GraphQL enums, which `gh` passes through; `gh`'s own docs do not list them (unverified there). A value outside the mapping table is a decode failure.

### `store.ts`

```ts
/** The plugin's database migrations; pass them to `ctx.database`. */
export const pullRequestMigrations: PluginMigrations
//   1_create_links: links(run_id TEXT, url TEXT, linked_at INTEGER, PRIMARY KEY (run_id, url))

/** The links of every run, in the plugin database. */
export interface LinkStore {
  /** Adds the link; `false` when it already existed. */
  readonly link: (runId: string, url: PullRequestUrl) => Effect<boolean>
  /** Removes the link; succeeds when there was none. */
  readonly unlink: (runId: string, url: PullRequestUrl) => Effect<void>
  /** The run's links, oldest first. */
  readonly list: (runId: string) => Effect<ReadonlyArray<PullRequestUrl>>
}

/** A {@link LinkStore} over the `SqlClient` `ctx.database` returned. */
export const makeLinkStore: Effect<LinkStore, never, SqlClient>
```

`linked_at` comes from `Clock.currentTimeMillis`. A row whose `url` no longer decodes is left out and logged, as in `plugins/dia-mcp/store.ts`. SQL errors die: the database is local and its schema is ours.

### `pull-requests.ts`

```ts
/** How often a followed run's pull requests are read again. */
export const POLL_INTERVAL = Duration.seconds(60)

/** Every run's linked pull requests and what dia last learned about each. */
export interface PullRequests {
  /**
   * Stores the link and returns `true`, or `false` when it already existed. For a new link it
   * starts the first read in the plugin's scope and does not wait for it; until the read ends
   * the pull request is `Reading`.
   */
  readonly link: (runId: string, url: PullRequestUrl) => Effect<boolean>
  /** Removes the link. */
  readonly unlink: (runId: string, url: PullRequestUrl) => Effect<void>
  /** Reads the pull request again and returns when the read ends. Does nothing for an unlinked URL. */
  readonly refresh: (runId: string, url: PullRequestUrl) => Effect<void>
  /**
   * The run's pull requests now and after each change. While the stream is consumed, every
   * {@link POLL_INTERVAL} it reads each pull request whose state is `Reading`, `ReadFailed`, or
   * `Read` with `open` or `draft`. The reads stop when the stream ends.
   */
  readonly follow: (runId: string) => Stream<ReadonlyArray<LinkedPullRequest>>
}

/** Builds {@link PullRequests}; background reads run in the calling scope. */
export const makePullRequests: (store: LinkStore, gh: GitHubCli) => Effect<PullRequests, never, Scope>
```

State: a `SynchronizedRef<HashMap<runId, RunState>>`, where `RunState` is `{ links: SubscriptionRef<ReadonlyArray<LinkedPullRequest>>, gates: Map<PullRequestUrl, Semaphore> }`. `runState(runId)` creates the entry inside `SynchronizedRef.modifyEffect` and loads the run's links from `LinkStore.list` once, each as `Reading`, so two concurrent first uses create one entry. `gate(url)` gets or creates the pull request's gate in one `Effect.sync` with `Semaphore.makeUnsafe(1)`; `unlink` deletes it. On first use of a run, the loaded links are read at once in the plugin's scope.

Plugin calls travel over `CallPlugin` and `SubscribePlugin` (`src/shared/ipc/rpc.ts`), so `DiaRpcs` does not change and `PROTOCOL_VERSION` stays.

Reads: each read (`link`'s first read, `refresh`, a poll tick) runs under that pull request's gate (`withPermit`) and updates only the entry with its URL, so an older read of one pull request never overwrites a newer one. A poll-tick read re-checks after it takes the gate and skips when the entry is no longer due: it is `Read` of a merged or closed pull request, or a `Read` whose `at` is less than half of `POLL_INTERVAL` before now (`Clock.currentTimeMillis`), so two followers of one run do not read the same pull request back to back. A read whose URL was unlinked meanwhile changes nothing. A poll tick reads its due pull requests with `Effect.forEach(…, { concurrency: 4, discard: true })`.

`link` order: `runState(runId)`, then `store.link`; when it returns `true`, one `SubscriptionRef.modify` appends the URL as `Reading` if `links` does not hold it and returns whether it did; only then does the read start.

`follow(runId)` is `Stream.merge(SubscriptionRef.changes(links), pollTicks)`, where `pollTicks` runs the due reads on `Schedule.spaced(POLL_INTERVAL)` (first tick one interval after the stream starts; unverified that `Stream.fromSchedule(Schedule.spaced(…))` waits before its first emission, so criterion 11's `TestClock` test asserts it) and emits nothing. The poll ends with the stream. The renderer's atom for a run is shared by the card and the panel, so a tab holds one stream. Whether the renderer's unmount interrupts the host stream is unverified in `src/host/plugins/plugin-messages.ts` (it uses `Stream.interruptWhen`); the app check for criterion 11 covers it.

Logs: debug for link, unlink, each read with `{ runId, url, outcome }`, poll start and stop; warning for a `ReadFailed`.

### `tool.ts`

```ts
/** The `link_pull_request` dia tool over `pullRequests`; register it with `when: isRunScope`. */
export const linkPullRequestTool: (pullRequests: PullRequests) => DiaTool
```

```ts
diaTool({
  name: 'link_pull_request',
  description: 'Link a GitHub pull request to this run, so the user sees it in the Pull requests card. Call it once after you open a pull request, with its URL.',
  input: Schema.Struct({ url: Schema.String }),
  run: ({ url }, scope) => …
})
```

| Input | Result |
|---|---|
| `https://github.com/draekien/dia/pull/295` | `Linked draekien/dia#295.` |
| the same URL again | `draekien/dia#295 is already linked.` |
| `https://gitlab.com/x/y/-/merge_requests/1` | `isError`: `Not a GitHub pull request URL: https://gitlab.com/x/y/-/merge_requests/1. Pass https://github.com/<owner>/<repo>/pull/<number>.` |
| a scope with no `runId` | `isError`: `link_pull_request needs a dia run.` (unreachable under `isRunScope`; it narrows the type) |

The tool returns before `gh` finishes: a failed read shows in the card, not in the tool result.

### `host.ts`

```ts
setup(ctx):
  sql  = ctx.database(pullRequestMigrations)
  gh   = makeGitHubCli, provided NodeServices.layer
  prs  = makePullRequests(makeLinkStore(sql), gh)
  ctx.serve(FollowRunPullRequests, ({ runId }) => prs.follow(runId))
  ctx.serve(UnlinkPullRequest, …); ctx.serve(RefreshPullRequest, …)
  ctx.whenProvided([ToolsKey], ({ tools }) => tools.register(linkPullRequestTool(prs), { when: isRunScope }))
```

`ToolsKey` comes from `@dia-plugin/dia-tools/tools`.

### Renderer

`atoms.ts`:

```ts
/** The renderer's atoms for the plugin's host calls. Make them once in `renderer.ts`. */
export const makePullRequestAtoms = (ctx) => ({
  /** The run's linked pull requests, followed from the host. */
  runPullRequests: Atom.family((runId: string) => Atom.make(followHost(ctx, FollowRunPullRequests, { runId }))),
  /** The pull request the panel shows per tab; unset, or naming an unlinked one, shows the first. */
  shown: Atom.family((paneId: PaneId) => Atom.make<PullRequestUrl | undefined>(undefined).pipe(Atom.keepAlive)),
  unlink, refresh   // callHost(UnlinkPullRequest | RefreshPullRequest)
})
```

`renderer.ts` adds, through `addEntry`, the `RailCardsSlot` entry `{ id: 'pull-requests', order: 60, title: 'Pull requests' }` and the `PanelsSlot` entry `{ id: 'pull-request', order: 50, title: 'Pull request' }`; both components get `runId: paneId`, as in `plugins/dia-checkpoints/renderer.ts`. The id `pull-request` is the one the card passes to `openRightPanel`.

`pull-requests-card.tsx`: a `<ul>` of rows, as the other rail cards draw them (`plugins/dia-chat/task-list-card.tsx`). The `List` component is not used: its description is hidden below 640px (`list.tsx:659`) and the rail is 288px. Each row is an `<a href={url} target="_blank" rel="noreferrer">` with two lines: the name, then the muted state line, both truncated. Rows have the hover fill of the sidebar rows and the focus ring `focus-visible:ring-[3px] ring-ring/50`. Each anchor has `aria-label` `Show #295 feat(pr): link pull requests in the Pull request panel` and the `title` `Ctrl+click to open in the browser` (`⌘+click` on macOS).

| Gesture | Effect |
|---|---|
| primary click with no modifier, `Enter` | `preventDefault`; set `shown(paneId)` to the URL; `openRightPanel(paneId, { plugin: 'dia-pull-requests', id: 'pull-request' })` |
| Ctrl+click, ⌘+click, Shift+click, middle-click | not prevented; the window's open handler passes the URL to `shell.openExternal` (`src/main/index.ts`) |

The handler opens the panel only when `event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey`. Middle-click fires `auxclick`, not `click`. On macOS Ctrl+click opens the context menu, so ⌘+click is the browser gesture there. That Ctrl+click and middle-click reach `setWindowOpenHandler` is unverified in Electron's docs (`electron.d.ts` names `target="_blank"` links and Shift+click); criterion 7's app check covers it.

| `read` | Name line | State line (muted) |
|---|---|---|
| `Reading` | `#295` | `draekien/dia` |
| `Read` | `#295 feat(pr): link pull requests` | `Open, checks passing` / `Draft, 2 checks failing` / `Merged` / `Closed`; checks part: `2 checks failing`, `checks pending`, `checks passing`, or nothing with no checks |
| `ReadFailed` | `#295` | the message |

No colour on the state line: per DESIGN.md, Error Red is for failed states only, and the card shows no attention signal. Empty: `No pull requests`.

`pull-request-panel.tsx`: the pull request `shown(paneId)` names if it is still linked, otherwise the first; opening the region from the header toggle leaves `shown` as it was. With two or more, a borderless `Select` of `#n title` above the body; choosing an entry sets `shown(paneId)`. Sections separated by hairlines:

1. Header: the title, `#295`, the state, `base ← head` in mono, the author, `+120 −34` as a `Figure`; buttons `Open in browser` (an `<a target="_blank">`), `Refresh`, `Unlink`. Under `Reading` the header shows `#295` and a `Skeleton`; under `ReadFailed` it shows the message and `Refresh`.
2. Checks: one `Status` row per check (dot `none` pending, `half` skipped, `full` passed or failed; Error Red only for `failed`), linking to its `url`. `No checks`.
3. Reviews and comments: one entry per activity in order; author in medium weight, review state as a caption, `RelativeTime` of `at`, body through `Markdown`. `No reviews or comments`.
4. Description: `Markdown` of `body`. `No description`.

No pull requests: `No pull requests linked to this run`.

A run's links stay in the database while its tab is archived; the rail and panel draw only for a shown chat tab, so they show again when the tab is restored.

Opening the panel can leave too little room for the rail beside it, which hides the card the user clicked (DESIGN.md › Right panel › With the session rail). This is accepted: the panel shows what the card showed.

### Kernel: `openRightPanel`

```ts
/** Opens the right panel of the tab showing `paneId` on the panel `id` that plugin `plugin` added. */
export const openRightPanel = (paneId: PaneId, panel: { readonly plugin: string; readonly id: string }): void
```

It sets `open: true` and `selected` to the panel's key, and logs at debug. The key format `<plugin>.<id>` stays inside `right-panel.ts`.

## Design rationale

**The tool, not output parsing, makes a link.** The user chose an explicit call. dia never parses tool output for URLs.

**`gh` in the Host, not a GitHub API client.** `gh` reuses the user's `gh auth`; dia stores no token. A missing or logged-out `gh` is a `ReadFailed` row, not a startup failure.

**The Host polls, the renderer follows.** Every plugin card and panel reads its host through `followHost` into an atom (`plugins/dia-checkpoints/changes-panel.tsx`, `plugins/dia-cost/usage-card.tsx`); the user chose this over TanStack Query. The poll lives inside the follow stream, so it runs only while a tab shows the card or panel.

**One gate per pull request, and a `gh` timeout** (Define Errors Out of Existence). Reads of one pull request are serialised, so an older read cannot overwrite a newer one; the timeout ensures a hung `gh` releases its gate.

**`PullRequestUrl` at the boundary** (Define Errors Out of Existence). The tool decodes its string input once; the store, `gh` and the calls take only the branded type.

**`state` as one four-value field** (Define Errors Out of Existence). `merged` with `isDraft: true` cannot be represented.

**`GitHubCli` hides `gh`'s JSON** (Information Hiding). The field list, the two check kinds and GitHub's enum spellings stay in `gh.ts`; `PullRequestDetails` is dia's shape.

**Ctrl+click through the anchor's default action.** The window's open handler already sends `http(s)` URLs to `shell.openExternal`, so the plugin needs no IPC to open a browser.

**`openRightPanel` takes the plugin and id, not a key string** (Information Hiding).

## Refinement Record

### Round 1

**Applied**
- *Correctness, blocker*: `exports` cannot list `markdown.tsx` (`PluginExport` matches only `.ts`, `manifest.ts:86`). Now `markdown-view.ts` re-exports `Markdown`. *Superseded during implementation*: an export may not import a `.tsx` file at all (`plugin-exports.test.ts`); the user chose a `dia-markdown` plugin that provides `MarkdownKey`.
- *Project rules, blocker*: the API bump refuses every plugin still on 0.0.43 (`isApiCompatible`, `manifest.ts:38`). All 28 `plugin.json` files move to 0.0.44; criterion 13 added.
- *Project rules, major*: inline `TaggedStruct`s inside unions extracted to named exports.
- *Project rules, major*: `PullRequestUrl` hand-declared its type and could not normalise with `brand` alone. Now a `decodeTo` transformation into a branded string; type derived.
- *Information Hiding / unspecified state, major*: per-run state, creation race and read serialisation specified (`SynchronizedRef<HashMap>`, per-run `Semaphore`).
- *Contradiction, major*: `link` now says it starts the read and does not wait; `refresh` waits.
- *DESIGN.md Record lists, major*: card rows use `List`/`ListRowLink`/`ListRowSubject`; panel uses `Figure`, `Status`, `RelativeTime`.
- *Project rules, major*: DESIGN.md and this spec added to the change list.
- *Minimize Complexity, minor*: `RcMap` dropped; the poll is merged into the follow stream.
- *Correctness, minor*: stream interruption marked unverified, covered by criterion 11 and the app check.
- *Correctness, minor*: click guard specified; Ctrl+click and middle-click marked unverified.
- *Minor*: rail hidden by an opened panel is accepted and stated.
- *Minor*: `shown` falls back when its URL is unlinked.
- *Minor*: `ReadFailed` is polled, so a transient failure recovers.
- *Minor*: field types given; `at` is epoch ms; `RunPullRequests` replaced by `Schema.Array(LinkedPullRequest)`.
- *Minor*: activity merges reviews and comments by time; inline review comments out of scope. Mapping table written from the `gh` 2.100.0 docs lookup.
- *Minor*: logging and JSDoc stated for each export.
- *Minor*: manifest written in full; `ToolsKey` import path given.

**Rejected**: none. **Escalated**: none.

### Round 2

**Applied**
- *DESIGN.md / criterion 5, major*: `ListRowDescription` is hidden below 640px (`list.tsx:659`), so the state line would never show in the 288px rail. The card now draws plain two-line rows, as `task-list-card.tsx` does. This reverses round 1's *Record lists* change for the card only: DESIGN.md's Record lists "Where" does not include the rail. The panel keeps `Status`, `Figure` and `RelativeTime`.
- *Concurrency, major*: a hung `gh` held the per-run gate. Gates are now per pull request, and `GH_TIMEOUT` (30s) kills a hung process; a tick reads with concurrency 4.
- *Race, minor*: a read re-checks whether it is due after taking the gate; `link` order stated; first poll tick is one interval after the stream starts.
- *Criterion 11, minor*: reworded to poll-tick reads.
- *Unspecified, minor*: slot entries and orders, `Select` sets `shown`, header toggle leaves `shown`, archived tabs, `pull-request-url.ts` platform-neutral.

**Rejected**: none. **Escalated**: none.

### Round 3

**Applied**
- *Correctness, major*: `GH_TIMEOUT` had no mechanism; closing the spawn scope waits for the process. Now `Effect.timeoutOrElse` around a scoped run, with `forceKillAfter: 5s` (verified at `effect/process/ChildProcess.ts:270`); `gh.test.ts` covers a process that never exits.
- *Minimize Complexity, major*: the gates map no longer sits in a second `SynchronizedRef`; it is a `Map` with synchronous get-or-create, and `unlink` removes the gate. The per-run single gate was considered and not chosen, because a user's `Refresh` would wait behind a tick reading every pull request of the run.
- *Correctness, minor*: the re-check also skips a `Read` newer than half the interval.
- *Correctness, minor*: first-tick delay marked unverified and asserted by test.
- *Unspecified, minor*: the `link` append is one atomic `SubscriptionRef.modify`.
- *Accessibility, minor*: row `aria-label`, `title` and the DESIGN.md focus ring.
- *Project rules, minor*: stated that `DiaRpcs` and `PROTOCOL_VERSION` do not change (verified: plugin calls use `CallPlugin` / `SubscribePlugin`).

**Rejected**: none. **Escalated**: none.
