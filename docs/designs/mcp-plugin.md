# MCP plugin

`plugins/mcp` owns MCP server configuration: the `McpServer` schema, the text a user edits, and the editor component. `org` stores a job title's MCP servers with the mcp schema and draws mcp's editor. `claude-code` decodes the servers a session receives with the mcp schema. The kernel carries a session's MCP servers without knowing their shape.

Scope: module (one new plugin, plus the kernel session contract and the `org` and `claude-code` call sites). Decisions confirmed by the user on 2026-11-07:

1. The mcp plugin owns the `McpServer` schema and its parse/print as the export `@dia-plugin/mcp/servers`. The kernel `SessionToolOptions.mcpServers` becomes `Record<string, unknown>`. claude-code decodes each entry with the mcp schema; an entry that fails to decode is left out of the session with a logged warning.
2. This PR moves ownership only. The editor stays a JSON textarea. Issue #197 (a structured form) replaces the editor inside mcp in the next PR.
3. org reads the editor as a renderer service that mcp provides, optionally. While no plugin provides it, the MCP servers field shows `Load the mcp plugin to edit MCP servers`, and the rest of the job title stays editable.

## Current state (read at `c07e6a4`)

| Location | Holds |
|---|---|
| `src/shared/domain/session-tools.ts` | `McpServer` (stdio, http, sse union), `PermissionRules`, `SessionToolOptions { permissions, mcpServers: Record<string, McpServer> }` |
| `src/host/plugin-api.ts:35-37` | Re-exports `McpServer`, `PermissionRules`, `SessionToolOptions` as `@dia/plugin` |
| `src/host/services/pane-supervisor.ts:213` | `tools: Option.none()`: no caller sends MCP servers to a session yet |
| `plugins/org/domain.ts:40` | `const McpServers = Schema.Record(Schema.String, McpServer)`, used by `JobTitle.mcpServers` and `JobTitleEdit.mcpServers` |
| `plugins/org/org.ts:34, 57, 72` | Stores `mcp_servers` as JSON of `JobTitle.fields.mcpServers`; follows `domain.ts` with no change |
| `plugins/org/mcp-json.ts` | `parseMcpServers(text)`, `printMcpServers(servers)`; tested in `mcp-json.test.ts`; listed in `tsconfig.web.json:44` |
| `plugins/org/job-title-editor.tsx:39-86, 203-208` | `Draft.mcpServers: string`; parse on save; unchanged-check by printed text; a mono `Textarea` with the caption `A JSON object of server name to server, as in .mcp.json without the "mcpServers" key.` |
| `plugins/claude-code/session-tool-options.ts` | `toSdkServer(server: McpServer)`; `sessionToolOptions(tools, diaToolServer)` is a pure function with one caller, `session.ts:531` |
| `src/renderer/src/lib/slots.tsx:85` | `useProvided(key)`: `undefined` while no plugin provides `key`; reads the registry directly, so the reader needs no manifest `inject`. Not exported from `@dia/renderer-plugin` |

## Modules

```
plugins/mcp/
  plugin.json         { "name": "mcp", "api": "0.0.30", "category": "feature", "renderer": "renderer.ts", "load": "eager", "exports": ["servers.ts", "editor.ts"] }
  draft.ts            internal: McpServersDraft brand and its text constructor
  servers.ts          export @dia-plugin/mcp/servers
  editor.ts           export @dia-plugin/mcp/editor
  servers-editor.tsx  internal: the textarea editor
  renderer.ts         provides the editor under McpServersEditorKey
```

`draft.ts` and `servers-editor.tsx` are not in `exports`, so another plugin cannot import them (ADR-0059). Every module export carries JSDoc.

### `servers.ts` (`@dia-plugin/mcp/servers`)

Imports `effect` and `type { McpServersDraft }` from `./draft`.

```ts
import type { McpServersDraft } from './draft'

/** One MCP server as `.mcp.json` declares it: stdio (`command`, `args`, `env`), http or sse (`url`, `headers`). */
export const McpServer = Schema.Union([...])   // moved unchanged from src/shared/domain/session-tools.ts
/** The decoded type of {@link McpServer}. */
export type McpServer = typeof McpServer.Type

/** MCP servers keyed by server name. */
export const McpServers = Schema.Record(Schema.String, McpServer)
/** The decoded type of {@link McpServers}. */
export type McpServers = typeof McpServers.Type

/** What the MCP servers editor holds while a user edits. Create one with `mcpServersDraft`; read one with `readMcpServersDraft`. */
export type { McpServersDraft }

/** The draft that shows `servers`. Two server maps that print the same give equal drafts. */
export const mcpServersDraft: (servers: McpServers) => McpServersDraft

/** The servers a draft describes, or the message to show under the editor. A blank draft is no servers. */
export const readMcpServersDraft: (draft: McpServersDraft) => Result.Result<McpServers, string>
```

`readMcpServersDraft` keeps today's `parseMcpServers` rules: a JSON object of server name to server; an entry with `command` and no `type` is stdio; a missing `args`, `env` or `headers` is empty; unknown keys are dropped. `mcpServersDraft` keeps `printMcpServers`: an empty string for no servers, otherwise two-space JSON.

### `draft.ts` (internal)

```ts
/** Text of the MCP servers editor. Branded so only mcp constructs one. */
export type McpServersDraft = string & Brand.Brand<'McpServersDraft'>
/** The draft holding `text` as typed. */
export const draftOfText = Brand.nominal<McpServersDraft>()
```

Only `servers.ts` and `servers-editor.tsx` call `draftOfText`. org holds a `McpServersDraft` and calls only `mcpServersDraft` and `readMcpServersDraft`. When #197 changes the draft's type, org's `Draft.mcpServers: McpServersDraft` and its calls compile unchanged.

### `editor.ts` (`@dia-plugin/mcp/editor`)

Imports `@dia/plugin`, `type` from `react` (allowed by `plugin-exports.test.ts:21-22`; precedent `plugins/adapters/slots.ts:2`) and `./servers`.

```ts
/**
 * Props of the MCP servers editor. `id` is the id of the control a `<label htmlFor>` names.
 * `draft` is the value shown; `onChange` receives each edit. `error` is shown under the control and
 * marks it invalid.
 */
export interface McpServersEditorProps {
  readonly id: string
  readonly draft: McpServersDraft
  readonly onChange: (draft: McpServersDraft) => void
  readonly error?: string
}

/** The MCP servers editor a plugin provides. Read it with `useProvided(McpServersEditorKey)`; it is `undefined` while no plugin provides it. */
export const McpServersEditorKey = ServiceKey.make(
  'mcpServersEditor',
  (value): value is ComponentType<McpServersEditorProps> => typeof value === 'function'
)
```

The key name follows the existing names `org`, `metaRepo`, `worktrees`.

### `servers-editor.tsx` and `renderer.ts`

`McpServersEditor` returns a fragment: the mono `Textarea` (`id`, `aria-invalid={error !== undefined}`), the caption `<p className="text-xs text-ink-muted">` and, when `error` is set, `<p className="text-xs text-error">`. These are moved from `job-title-editor.tsx:152-168, 203-208`; `Textarea` comes from `@dia/renderer-plugin`. `onChange` passes `draftOfText(event.target.value)`. `renderer.ts` calls `ctx.provide(McpServersEditorKey, McpServersEditor)` (the same call `src/shared/plugin/list-slot.ts` makes for a list).

## Kernel changes

```ts
// src/shared/domain/session-tools.ts
export const SessionToolOptions = Schema.Struct({
  permissions: PermissionRules,
  /** MCP servers keyed by name. The kernel does not read a value; the adapter decodes it with `@dia-plugin/mcp/servers`. */
  mcpServers: Schema.Record(Schema.String, Schema.Unknown)
})
```

- `McpServer` is deleted from `session-tools.ts` and from `src/host/plugin-api.ts:35`.
- `useProvided` is exported from `src/renderer/src/plugin-api.ts` (`@dia/renderer-plugin`).
- `PLUGIN_API_VERSION` (`src/shared/plugin/manifest.ts:24`) goes from 0.0.29 to 0.0.30, because `@dia/plugin` loses `McpServer` and `@dia/renderer-plugin` gains `useProvided`. Below 0.1.0 the loader accepts only an exact match, so `api` becomes `"0.0.30"` in all 13 existing `plugins/*/plugin.json`.
- `SessionToolOptions` is not in `DiaRpcs`, so `PROTOCOL_VERSION` stays.

## org changes

- `domain.ts`: imports `McpServers` from `@dia-plugin/mcp/servers`; the local `McpServers` constant and the `McpServer` import from `@dia/plugin` are deleted.
- `job-title-editor.tsx`:
  - `Draft.mcpServers` becomes `McpServersDraft`; `draftOf` uses `mcpServersDraft`.
  - The `textarea` helper's `field` becomes `Exclude<keyof Draft, 'bypassOptIn' | 'mcpServers'>`, and its `'mcpServers'` call (`:203-208`) is removed. The editor's `onChange` runs `setDraft((current) => ({ ...current, mcpServers: next }))` and `setErrors({})`.
  - `editOf(jobTitle, draft, mcpEditable)`: when `mcpEditable` is true it reads with `readMcpServersDraft` and sends `mcpServers` when `mcpServersDraft(parsed) !== mcpServersDraft(jobTitle.mcpServers)`, as today; when false it leaves `mcpServers` out of the edit and never sets `FormErrors.mcpServers`. `Editor` is read once at the top of `EditForm`, and both call sites (`pending` at `:123`, `save` at `:132`) pass `Editor !== undefined`.
  - The field reads `const Editor = useProvided(McpServersEditorKey)`. Present: org's `Field` with the `MCP servers` label and no `caption` or `error`, holding `<Editor id draft onChange error={errors.mcpServers} />`. Absent: the label and `Load the mcp plugin to edit MCP servers` in muted text, in muted text under the label, which then names no control (there is none to describe), in the wording `pane-creation-form.tsx:225-229` uses for worktrees.
- `mcp-json.ts` and `mcp-json.test.ts` are deleted.

## claude-code changes

`sessionToolOptions` becomes an `Effect`. For each `mcpServers` entry it decodes with `McpServer` from `@dia-plugin/mcp/servers`. An entry that fails is left out and logged with `Effect.logWarning('An MCP server was left out of the session', { server, message })`. The rest convert with `toSdkServer`. `session.ts` runs `const toolOptions = yield* sessionToolOptions(additions.tools, ...)` after the `dia` replaced-warning (`:505`) and before the `query(...)` call, which spreads `...toolOptions` in place of the call at `:531`. `session.ts:494, 503` read only the keys of `tools.mcpServers` and stay valid with `Record<string, unknown>`.

Known limit: the pane shows nothing when a server is left out; only the log does. org validates on save, so this happens only when a stored value no longer decodes.

## Tests

| Criterion | Test |
|---|---|
| Parse and print rules unchanged | `plugins/mcp/servers.test.ts`: the cases of `mcp-json.test.ts`, calling `readMcpServersDraft` and `mcpServersDraft` |
| org edits and saves MCP servers as before | `plugins/org/org-page.test.tsx`: a `describe` whose `beforeEach` calls `startRendererRegistry({ mcp: (ctx) => ctx.provide(McpServersEditorKey, StubEditor) })` (`renderer-registry.fake.ts:19`). `StubEditor` renders `<textarea id={id} value={draft} aria-invalid={error !== undefined}>` and the error text, casting input to `McpServersDraft`. The existing cases at `:383-391` move into it |
| With no editor provided, the hint shows and other fields save | New `org-page.test.tsx` case with no registry started |
| A session receives job-title servers through the real path | Existing `plugins/claude-code/session-queue.test.ts:760-793` still passes |
| claude-code passes servers as before; an invalid entry is left out | `session-tool-options.test.ts`: existing cases run the Effect with `Effect.runSync` through a local helper; the `McpServer` import moves to `@dia-plugin/mcp/servers`; a new case passes `{ type: 'ftp' }` beside a valid server and asserts the valid server alone reaches the SDK options |
| The mcp renderer provides the textarea editor, and an edit reaches `onChange` | `plugins/mcp/renderer.test.tsx` |
| No kernel or `@dia/plugin` export names `McpServer` | `pnpm typecheck` after deletion |

## Docs and config

- `tsconfig.web.json`: `plugins/org/mcp-json.ts` removed from `include`; `plugins/mcp/servers.ts`, `plugins/mcp/draft.ts` and `plugins/mcp/editor.ts` added. `tsconfig.plugin-exports.json`: the same three added. `draft.ts` is listed because `tsconfig.web.json` is a composite project, which fails with TS6307 on an imported file it does not list.
- New ADR `0066`: a kernel contract field whose shape a plugin owns is `unknown` in the kernel and decoded by its reader with the owner's export. It applies ADR-0062's rule ("a contract only plugins use lives in an exported module of the plugin that owns it") to a field inside a kernel contract. Added to `docs/adr/README.md`. ADR-0065's "Follow-up" line links to it.
- `docs/designs/org-screens.md` gets the line "Superseded in part by `mcp-plugin.md`"; its `mcp-json.ts` references stay as the record of that design.
- `docs/designs/adapters-as-ordinary-plugins.md:87` ("next PR") links this spec. `docs/designs/org-job-titles.md:116, 120` (`McpServer` in `@shared/domain/session-tools`) get the line "Superseded in part by `mcp-plugin.md`".
- This spec is written to `docs/designs/mcp-plugin.md`.

## Out of scope

- #197's structured editor.
- Sending a job title's MCP servers to a session (`pane-supervisor.ts:213` stays `Option.none()`).
- Moving `PermissionRules` out of the kernel.

## Refinement Record

| Round | Finding | Tag | Outcome |
|---|---|---|---|
| 1 | `tsconfig.web.json` still lists the deleted `mcp-json.ts` | blocker | Applied (verified `tsconfig.web.json:44`) |
| 1 | No exported way to build a `McpServersDraft` from editor text | blocker | Applied: internal `draft.ts` with `draftOfText`, outside `exports` |
| 1 | ADR index, ADR-0065 follow-up and all `org-screens.md` references missing | major | Applied (verified lines 152, 159, 204, 237, 278) |
| 1 | JSDoc missing on type aliases and editor; internal modules not stated | major | Applied |
| 1 | `api` left as a placeholder | major | Applied: 0.0.30, 13 existing manifests |
| 1 | Dropped server has no UI signal | major | Applied as a stated known limit; the behaviour is the user's decision |
| 1 | `editOf` cannot know the editor is absent | minor | Applied: `mcpEditable` parameter |
| 1 | org tests cannot import mcp's internal editor | minor | Applied: stub via registry fake |
| 1 | `session-tool-options.test.ts` must move to `it.effect` | minor | Applied |
| 1 | `sameMcpServers` changes the unchanged-check to ignore key order | minor | Applied: export dropped; org compares printed drafts as today |
| 1 | Key name `mcp.serversEditor` differs from `org`, `metaRepo` | minor | Applied: `mcpServersEditor` |
| 2 | `export type { X } from` does not bring `McpServersDraft` into `servers.ts` scope | blocker | Applied: `import type` plus `export type { McpServersDraft }` |
| 2 | `draft.ts` need not be listed in the tsconfigs | minor | Applied, then reverted during implementation: `pnpm typecheck` fails with TS6307 without the entry |
| 2 | Hint precedent is at `pane-creation-form.tsx:225-229` and uses `aria-describedby` | minor | Applied |
| 3 | Split of label, caption and error between org's `Field` and the editor unstated | major | Applied: editor draws textarea, caption and error; org's `Field` keeps the label (verified `job-title-editor.tsx:91-112`) |
| 3 | `textarea` helper still accepts `'mcpServers'` | major | Applied |
| 3 | org test stub and registry setup underspecified | major | Applied |
| 3 | Both `editOf` call sites need `mcpEditable` | minor | Applied |
| 3 | Placement of the `sessionToolOptions` yield; `session-queue.test.ts` coverage | minor | Applied |
| 3 | `import type` placed after code in the listing | minor | Applied |
| 3 | Stale references in `adapters-as-ordinary-plugins.md` and `org-job-titles.md` | minor | Applied |
| 3 | `session.ts:494, 503` stay valid | minor | Applied to claude-code changes |
