# Create a job title

Scope: one method on the `Org` service (`plugins/dia-org`) plus a create mode of the job title editor. Issue #292.

`Org.createJobTitle` stores a new job title with every field supplied by the caller. The Job titles page gets a "New job title" button that opens an empty editor whose Save calls it.

## Success criteria

1. `createJobTitle(fields)` returns a job title with `enabled: true` and `builtIn: null`, and `jobTitles` then lists it.
2. `createJobTitle` with a name that another job title holds, in any ASCII case, fails with `JobTitleNameTaken` and `jobTitles` is unchanged.
3. With no registry held, `createJobTitle` fails with `JobTitlesNotLoaded`.
4. In the app: Save in the editor opened by "New job title" adds the job title to the list, selects it, and its `Hire…` button hires an agent of it.
5. In the app: Save with an existing job title's name shows `A job title named "<name>" already exists` under the Name field, and the list is unchanged.
6. `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.

## Interface

`plugins/dia-org/domain.ts`:

```ts
/** Every field of a job title's agent definition except `id`: what a new job title is made from. */
export const JobTitleFields = AgentDefinition.mapFields((fields) => Struct.omit(fields, ['id']))
/** The decoded type of {@link JobTitleFields}. */
export type JobTitleFields = typeof JobTitleFields.Type

/**
 * Failure of creating a job title: the `agent-definitions` plugin is not ready, so there is no
 * registry to store it in.
 */
export class JobTitlesNotLoaded extends Schema.TaggedError<JobTitlesNotLoaded>()('JobTitlesNotLoaded', {}) {}
```

`plugins/dia-org/service.ts`, a new `Org` member (and its entry in `MEMBERS`):

```ts
readonly createJobTitle: (
  fields: JobTitleFields
) => Effect.Effect<JobTitle, JobTitleNameTaken | JobTitlesNotLoaded>
```

The `Org` JSDoc sentence "with none held, `jobTitles` is empty and every job title change fails with `JobTitleNotFound`" (`service.ts:33-34`) becomes "...and every job title change except `createJobTitle` fails with `JobTitleNotFound`". A new sentence follows `copyJobTitle`'s: "`createJobTitle` stores a new enabled job title, not built in, with `fields`; it fails with `JobTitlesNotLoaded` while no registry is held."

`plugins/dia-org/calls.ts`:

```ts
/** Creates an enabled job title, not built in, with the given fields. */
export const CreateJobTitle = Rpc.make('CreateJobTitle', {
  payload: JobTitleFields.fields,
  success: JobTitle,
  error: Schema.Union([JobTitleNameTaken, JobTitlesNotLoaded])
})
```

`plugins/dia-org/host.ts`: `ctx.serve(CreateJobTitle, (fields) => org.createJobTitle(fields))`.

`CreateJobTitle` is a plugin RPC, not a member of `DiaRpcs`, so `PROTOCOL_VERSION` in `src/shared/ipc/rpc.ts` is unchanged.

`plugins/dia-org/org-actions.ts`: `commonFailureText` returns `'Job titles are not loaded yet'` for `JobTitlesNotLoaded`.

`plugins/dia-org/job-title-editor.tsx`:

```tsx
/**
 * The empty job title editor the Job titles page shows after "New job title": a `New job title`
 * heading and the edit form with the default fields. `Save` creates the job title, shows it with
 * `show(JobTitlesView.make({ jobTitleId }))` and then calls `onClose`; `Cancel` calls `onClose`.
 */
export function NewJobTitleEditor(props: Pick<OrgScreen, 'snapshot' | 'call' | 'show'> & {
  readonly onClose: () => void
})
```

`plugins/dia-org/job-titles-page.tsx`: a `New job title` outline button above the list. The page holds `creating: boolean`. While it is true the detail pane shows `NewJobTitleEditor` and the list selects nothing. It becomes false when:
- the list's `onSelect` runs, which sets `creating` to false and then calls `show`, so clicking the job title that was selected before also leaves the empty editor;
- Cancel or a successful Save calls `onClose`;
- the page's `jobTitleId` prop changes for any other reason.

## Key Data Structures

The empty editor's draft, in `job-title-editor.tsx`. `Draft` (`job-title-editor.tsx:43-54`) holds list fields as newline-joined text:

```ts
const NEW_JOB_TITLE_DRAFT: Draft = {
  name: '', jobDescription: '', skills: '', allow: '', ask: '', deny: '', mcpServers: '',
  bypassOptIn: false, model: null, thinkingLevel: DEFAULT_THINKING_LEVEL
}
```

These match a built-in job title's defaults (`built-in-job-titles.ts:190-200`); `DEFAULT_THINKING_LEVEL` is `'medium'` (`src/shared/domain/pane.ts:94`). `name: ''` is not a valid `JobTitleName`, so this is a `Draft`, not a `JobTitleFields`.

`fieldsOf(draft): Result<JobTitleFields, Omit<FormErrors, 'save'>>` reads every draft field into `JobTitleFields`, reading the name with `readJobTitleName` (a blank name gives `Enter a name`) and list fields with `lines()`. `editOf(jobTitle, fields): JobTitleEdit` diffs typed fields against `jobTitle`: a field is present when it differs, permissions are sent as one group when any of `allow`, `ask`, `deny` differs, and lists are compared with `sameLines`. The edit save still sends `{ jobTitleId, edit }` with today's contents (`org-page.test.tsx:637` asserts the payload).

## Internal Decomposition

- **`createIn(registry, fields)`** in `org.ts` — calls `registry.create(fields)`, maps `AgentDefinitionNameTaken` to `JobTitleNameTaken`, and returns `toJobTitle(created, true)`. It does not log; each caller logs. `copyJobTitle` and `createJobTitle` both call it; `copyJobTitle` keeps its own `JobTitleNotFound` lookup and its `Copied job title` log.
- **`createJobTitle`** in `org.ts` — reads the held registry, logging `Refused to create a job title: no registry held` and failing with `JobTitlesNotLoaded` when none is held. It calls `createIn` and logs `Created job title` with `{ jobTitleId, name }`. A name clash is already logged by the registry (`Agent definition create refused`, `make-registry.ts:151`), so it is not logged again.
- **`JobTitleForm`** in `job-title-editor.tsx` (renamed from `EditForm`, which now serves create too) — takes `initial: Draft`, `nameEditable: boolean`, `onSave: (fields: JobTitleFields) => Promise<FormErrors>` (empty on success) and an optional `onCancel`. It does not know which RPC it calls.
  - `Save` is disabled while busy or while the draft equals `initial`. Equality compares `draft` with `initial` field by field: `name` trimmed, `jobDescription` as raw text, `skills`, `allow`, `ask`, `deny` and `mcpServers` with `sameLines(lines(a), lines(b))`, and `bypassOptIn`, `model` and `thinkingLevel` with `===`. So an edit that changes only blank lines keeps Save disabled (`org-page.test.tsx:649`). This is today's rule for an edit (`job-title-editor.tsx:213`); a new job title's Save is disabled until the first edit.
  - A `Cancel` button is rendered beside `Save` when `onCancel` is given.
  - `JobTitleEditor` passes `draftOf(jobTitle)`, `nameEditable: jobTitle.builtIn === null`, and an `onSave` that diffs with `editOf` and calls `EditJobTitle`. It keeps its `editKey` remount (`job-title-editor.tsx:409,448`).
  - `NewJobTitleEditor` passes `NEW_JOB_TITLE_DRAFT`, `nameEditable: true`, `onCancel: onClose`, and an `onSave` that calls `CreateJobTitle` and maps `JobTitleNameTaken` to the Name field error. It is not keyed, so a snapshot refresh does not reset the draft.

The watch stream needs no change: the `Org` JSDoc already states `watchJobTitleChanges` emits after each change to the held registry's definitions, which `registry.create` is.

## Tests

- `plugins/dia-org/org.test.ts`:
  - `createJobTitle` returns `enabled: true` and `builtIn: null`, and `jobTitles` lists it.
  - A name that differs from an existing job title's only in ASCII case fails with `JobTitleNameTaken`, and `jobTitles` is unchanged.
  - With no registry held, it fails with `JobTitlesNotLoaded`.
  - `watchJobTitleChanges` emits after `createJobTitle`.
- `plugins/dia-org/host.test.ts`: `call(registry, 'CreateJobTitle', fields)` (pattern at `host.test.ts:236`) with every field set to a non-default value, then `readOrg`: the listed job title equals `fields` plus `builtIn: null` and `enabled: true`. This is the project rule's check that each payload field reaches the handler unchanged. `startOrg` loads the real `agent-definitions` plugin, so `JobTitlesNotLoaded` is tested in `org.test.ts` only.
- `plugins/dia-org/org-host.fake.tsx`: add `calls.CreateJobTitle` to `RPCS` (`:114-134`).
- `plugins/dia-org/org-page.test.tsx`, beside the Copy and Edit cases: `New job title` shows the empty editor with Save disabled; typing a description then Save shows `Enter a name` and sends nothing; Save with a taken name shows `A job title named "<name>" already exists`; a successful Save sends every field and shows the new job title; Cancel shows the selected job title again.
- Criterion 4's `Hire…` on the new job title is checked in the app run (`verify-in-app`).

## Design Rationale

**Full fields, not a partial with defaults** — the service takes every field, so the defaults live where they are shown: the editor. #293's agent tool can then choose its own defaults or require them, and the service has one rule (store what it is given) instead of a second set of defaults that could drift from the editor's.

**`JobTitlesNotLoaded`, not `JobTitleNotFound`** — a create names no job title, so `JobTitleNotFound(jobTitleId)` has nothing to name. The new error follows `IssuesNotLoaded` (`domain.ts:297`), the existing name for "a held dependency is missing".

**The payload is the fields themselves** — `payload: JobTitleFields.fields` makes the RPC payload the job title fields, with no wrapper field to name, so no wrapper name can collide with a payload field.

**`JobTitleForm` takes `onSave`** — the edit and the create differ only in which RPC Save calls and which errors it maps. Passing the save in keeps one form for both, and the form stays unaware of the RPCs (Information Hiding).

**Page-local `creating` state** — the user chose this over a `JobTitlesView` variant. `OrgView` and its normalisation stay unchanged; the cost is that the empty editor is not restored after a reload, which loses only a draft.

## Rejected Alternatives

**A `JobTitlesView` `new` selection** — rejected by the user: it changes the org view schema and how a view resolves against the snapshot for a state that holds only an unsaved draft.

**A modal with the full editor** — rejected by the user: about nine fields, including the skill and MCP pickers, inside a dialog.

**`createJobTitle(name)` with server-side defaults** — rejected: the issue specifies every field except `id`, and #293's tool needs to set them in one call.

## Refinement Record

**Applied (round 1)**
- *Correctness* — `NEW_JOB_TITLE` was not a type and did not match `Draft`'s newline-joined fields; now `NEW_JOB_TITLE_DRAFT: Draft`, with `fieldsOf` named.
- *Project rules (no inline comments)* — the `// 'medium'` comment in the defaults block removed.
- *Project rules (JSDoc on exports)* — `JobTitleFields` type gained its JSDoc.
- *Correctness (Effect v4)* — `mapFields(Struct.omit(['id']))` replaced by the explicit `(fields) => Struct.omit(fields, ['id'])` form `AgentDefinitionEdit` uses (`registry.ts:37-39`).
- *Correctness* — nothing cleared `creating` after Save; `NewJobTitleEditor` now calls `onClose` after `show`.
- *Project rules (tests)* — Tests section added.
- *Logging* — the create log carries `{ jobTitleId, name }`; the name clash is not logged twice.
- *Information Hiding* — `createIn` stated not to log.
- *Names as Documentation* — `JobTitlesNotLoaded` JSDoc names the missing plugin.
- *Completeness* — `EditForm`'s `nameEditable` and `changed` stated; create mode keeps Save enabled so a blank name reports `Enter a name`.

**Applied (round 2)**
- *Strategic Programming* — the `changed` prop (with `() => true` for create) removed; the form derives it from `initial`.
- *Project rules (tests)* — the fake host's `RPCS` and `org-page.test.tsx` named.
- *Correctness* — `host.test.ts` has no job title RPC test; the case is now stated with the `call` + `readOrg` pattern.
- *Coverage* — criterion 4's `Hire…` assigned to the app run.
- *Names as Documentation* — `EditForm` renamed `JobTitleForm`; `Cancel` stated as rendered only with `onCancel`.
- *Correctness* — `editOf`'s diff now stated over typed fields, with the edit payload unchanged.
- *Consistency* — the `Org` JSDoc's "every job title change fails with `JobTitleNotFound`" excepts `createJobTitle`; `PROTOCOL_VERSION` stated unchanged (plugin RPCs are not in `DiaRpcs`; `src/` has no `CopyJobTitle` reference).

**Applied (round 3)**
- *Correctness* — the draft-equality rule now names the comparison for every field, keeping the description raw as today (`job-title-editor.tsx:87`). Taken with a change: the reviewer's `fieldsOf(initial)` comparison fails on a new job title's blank name, which would enable Save on an untouched form.
- *Correctness* — `creating` is also cleared when `jobTitleId` changes for another reason.
- *Correctness* — `onSelect` clears `creating` itself, so re-selecting the previously selected job title leaves the empty editor.
- *Style* — the `JSX.Element` return annotation removed; no neighbouring component annotates its return type.
